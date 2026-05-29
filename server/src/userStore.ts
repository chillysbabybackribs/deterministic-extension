import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { BillingPlan, UserRecord, UserStore } from "./types.js";

type UserRow = {
  id: string;
  clerk_user_id: string;
  email: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_status: string | null;
  stripe_subscription_plan: string | null;
  stripe_current_period_end: number | null;
  stripe_subscription_updated_at: number | null;
  created_at: string;
  updated_at: string;
};

export class SqliteUserStore implements UserStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    ensureParentDirectory(databasePath);
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.createSchema();
  }

  getOrCreateUser(args: { clerkUserId: string; email: string | null }): UserRecord {
    const existing = this.selectByClerkUserId(args.clerkUserId);
    const now = new Date().toISOString();

    if (!existing) {
      const created: UserRow = {
        id: randomUUID(),
        clerk_user_id: args.clerkUserId,
        email: args.email,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        stripe_subscription_status: null,
        stripe_subscription_plan: null,
        stripe_current_period_end: null,
        stripe_subscription_updated_at: null,
        created_at: now,
        updated_at: now
      };

      this.db
        .prepare(
          `insert into users (
             id,
             clerk_user_id,
             email,
             stripe_customer_id,
             stripe_subscription_id,
             stripe_subscription_status,
             stripe_subscription_plan,
             stripe_current_period_end,
             stripe_subscription_updated_at,
             created_at,
             updated_at
           )
           values (
             @id,
             @clerk_user_id,
             @email,
             @stripe_customer_id,
             @stripe_subscription_id,
             @stripe_subscription_status,
             @stripe_subscription_plan,
             @stripe_current_period_end,
             @stripe_subscription_updated_at,
             @created_at,
             @updated_at
           )`
        )
        .run(created);

      return mapUserRow(created);
    }

    if (existing.email !== args.email) {
      this.db
        .prepare(
          `update users
           set email = @email,
               updated_at = @updated_at
           where clerk_user_id = @clerk_user_id`
        )
        .run({
          clerk_user_id: args.clerkUserId,
          email: args.email,
          updated_at: now
        });

      return {
        ...mapUserRow(existing),
        email: args.email,
        updatedAt: now
      };
    }

    return mapUserRow(existing);
  }

  setStripeCustomerId(userId: string, stripeCustomerId: string): UserRecord {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `update users
         set stripe_customer_id = @stripe_customer_id,
             updated_at = @updated_at
         where id = @id`
      )
      .run({
        id: userId,
        stripe_customer_id: stripeCustomerId,
        updated_at: now
      });

    const updated = this.selectById(userId);
    if (!updated) {
      throw new Error(`Unable to find user ${userId} after updating stripe customer id.`);
    }

    return mapUserRow(updated);
  }

  getUserByStripeCustomerId(stripeCustomerId: string): UserRecord | null {
    const row = this.selectByStripeCustomerId(stripeCustomerId);
    return row ? mapUserRow(row) : null;
  }

  setStripeSubscriptionState(args: {
    userId: string;
    stripeSubscriptionId: string | null;
    stripeSubscriptionStatus: string | null;
    stripeSubscriptionPlan: BillingPlan | null;
    stripeCurrentPeriodEnd: number | null;
    stripeSubscriptionUpdatedAt?: number | null;
  }): UserRecord {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `update users
         set stripe_subscription_id = @stripe_subscription_id,
             stripe_subscription_status = @stripe_subscription_status,
             stripe_subscription_plan = @stripe_subscription_plan,
             stripe_current_period_end = @stripe_current_period_end,
             stripe_subscription_updated_at = @stripe_subscription_updated_at,
             updated_at = @updated_at
         where id = @id`
      )
      .run({
        id: args.userId,
        stripe_subscription_id: args.stripeSubscriptionId,
        stripe_subscription_status: args.stripeSubscriptionStatus,
        stripe_subscription_plan: args.stripeSubscriptionPlan,
        stripe_current_period_end: args.stripeCurrentPeriodEnd,
        stripe_subscription_updated_at: args.stripeSubscriptionUpdatedAt ?? null,
        updated_at: now
      });

    const updated = this.selectById(args.userId);
    if (!updated) {
      throw new Error(`Unable to find user ${args.userId} after updating stripe subscription state.`);
    }

    return mapUserRow(updated);
  }

  hasProcessedWebhookEvent(eventId: string): boolean {
    const exists = this.db
      .prepare("select event_id from stripe_webhook_events where event_id = ?")
      .get(eventId) as { event_id: string } | undefined;

    return Boolean(exists);
  }

  recordWebhookEvent(eventId: string, type: string): boolean {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `insert into stripe_webhook_events (
             event_id,
             type,
             created_at
           )
           values (@event_id, @type, @created_at)`
        )
        .run({
          event_id: eventId,
          type,
          created_at: now
        });
      return true;
    } catch (error) {
      if (isConstraintError(error)) {
        return false;
      }
      throw error;
    }
  }

  clearWebhookEvent(eventId: string): void {
    this.db
      .prepare("delete from stripe_webhook_events where event_id = ?")
      .run(eventId);
  }

  close(): void {
    this.db.close();
  }

  private createSchema(): void {
    this.db.exec(`
      create table if not exists users (
        id text primary key,
        clerk_user_id text not null unique,
        email text,
        stripe_customer_id text,
        stripe_subscription_id text,
        stripe_subscription_status text,
        stripe_subscription_plan text,
        stripe_current_period_end integer,
        stripe_subscription_updated_at integer,
        created_at text not null,
        updated_at text not null
      );

      create unique index if not exists users_clerk_user_id_idx
        on users (clerk_user_id);

      create table if not exists stripe_webhook_events (
        event_id text primary key,
        type text not null,
        created_at text not null
      );
    `);

    const userColumns = this.db.prepare("pragma table_info(users)").all() as Array<{ name: string }>;
    ensureUserColumn(this.db, userColumns, "stripe_customer_id", "text");
    ensureUserColumn(this.db, userColumns, "stripe_subscription_id", "text");
    ensureUserColumn(this.db, userColumns, "stripe_subscription_status", "text");
    ensureUserColumn(this.db, userColumns, "stripe_subscription_plan", "text");
    ensureUserColumn(this.db, userColumns, "stripe_current_period_end", "integer");
    ensureUserColumn(this.db, userColumns, "stripe_subscription_updated_at", "integer");

    this.db.exec(`
      create table if not exists stripe_webhook_events (
        event_id text primary key,
        type text not null,
        created_at text not null
      );
    `);
  }

  private selectById(userId: string): UserRow | undefined {
    return this.db
      .prepare(
        `select
           id,
           clerk_user_id,
           email,
           stripe_customer_id,
           stripe_subscription_id,
           stripe_subscription_status,
           stripe_subscription_plan,
           stripe_current_period_end,
           stripe_subscription_updated_at,
           created_at,
           updated_at
         from users
         where id = ?`
      )
      .get(userId) as UserRow | undefined;
  }

  private selectByClerkUserId(clerkUserId: string): UserRow | undefined {
    return this.db
      .prepare(
        `select
           id,
           clerk_user_id,
           email,
           stripe_customer_id,
           stripe_subscription_id,
           stripe_subscription_status,
           stripe_subscription_plan,
           stripe_current_period_end,
           stripe_subscription_updated_at,
           created_at,
           updated_at
         from users
         where clerk_user_id = ?`
      )
      .get(clerkUserId) as UserRow | undefined;
  }

  private selectByStripeCustomerId(stripeCustomerId: string): UserRow | undefined {
    return this.db
      .prepare(
        `select
           id,
           clerk_user_id,
           email,
           stripe_customer_id,
           stripe_subscription_id,
           stripe_subscription_status,
           stripe_subscription_plan,
           stripe_current_period_end,
           stripe_subscription_updated_at,
           created_at,
           updated_at
         from users
         where stripe_customer_id = ?`
      )
      .get(stripeCustomerId) as UserRow | undefined;
  }
}

export function createMemoryUserStore(): SqliteUserStore {
  return new SqliteUserStore(":memory:");
}

function ensureParentDirectory(filePath: string): void {
  if (filePath === ":memory:") {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function mapUserRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    clerkUserId: row.clerk_user_id,
    email: row.email,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripeSubscriptionStatus: row.stripe_subscription_status,
    stripeSubscriptionPlan: row.stripe_subscription_plan as BillingPlan | null,
    stripeCurrentPeriodEnd: row.stripe_current_period_end,
    stripeSubscriptionUpdatedAt: row.stripe_subscription_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function isConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: string }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

function ensureUserColumn(db: Database.Database, columns: Array<{ name: string }>, name: string, type: string): void {
  if (columns.some((column) => column.name === name)) {
    return;
  }

  db.exec(`alter table users add column ${name} ${type};`);
}
