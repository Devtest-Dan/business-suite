CREATE TYPE "public"."customers_activity_kind" AS ENUM('call', 'email', 'meeting', 'note', 'stage_change');--> statement-breakpoint
CREATE TYPE "public"."customers_field_entity" AS ENUM('contact', 'company', 'deal');--> statement-breakpoint
CREATE TYPE "public"."customers_field_type" AS ENUM('text', 'number', 'date', 'choice');--> statement-breakpoint
CREATE TYPE "public"."customers_filter_entity" AS ENUM('contacts', 'companies', 'deals');--> statement-breakpoint
CREATE TYPE "public"."customers_follow_up_status" AS ENUM('open', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."customers_follow_up_via" AS ENUM('here', 'tasks');--> statement-breakpoint
CREATE TYPE "public"."customers_stage_kind" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "customers_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "customers_activity_kind" NOT NULL,
	"body" text NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"deal_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_id" uuid,
	"author_name" text NOT NULL,
	"via" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_key" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("body", ''))) STORED,
	CONSTRAINT "customers_activities_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "customers_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_key" text,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("name", '')), 'A') || setweight(to_tsvector('simple', coalesce("email", '') || ' ' || coalesce("website", '')), 'B') || setweight(to_tsvector('simple', coalesce("notes", '')), 'C')) STORED,
	CONSTRAINT "customers_companies_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "customers_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"job_title" text DEFAULT '' NOT NULL,
	"company_id" uuid,
	"address" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"email_key" text DEFAULT '' NOT NULL,
	"phone_key" text DEFAULT '' NOT NULL,
	"name_key" text DEFAULT '' NOT NULL,
	"owner_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_key" text,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("name", '')), 'A') || setweight(to_tsvector('simple', coalesce("email", '') || ' ' || coalesce("phone", '') || ' ' || coalesce("job_title", '')), 'B') || setweight(to_tsvector('simple', coalesce("notes", '')), 'C')) STORED,
	CONSTRAINT "customers_contacts_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "customers_deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"stage_id" uuid NOT NULL,
	"value_cents" bigint,
	"expected_close" date,
	"notes" text DEFAULT '' NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_id" uuid,
	"created_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_key" text,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce("notes", '')), 'C')) STORED,
	CONSTRAINT "customers_deals_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "customers_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity" "customers_field_entity" NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "customers_field_type" DEFAULT 'text' NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers_follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"due_on" date NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"deal_id" uuid,
	"assignee_id" uuid,
	"status" "customers_follow_up_status" DEFAULT 'open' NOT NULL,
	"via" "customers_follow_up_via" DEFAULT 'here' NOT NULL,
	"task_approval_id" uuid,
	"task_id" text,
	"notified_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_key" text,
	CONSTRAINT "customers_follow_ups_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "customers_saved_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity" "customers_filter_entity" NOT NULL,
	"name" text NOT NULL,
	"query" jsonb NOT NULL,
	"user_id" uuid NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"kind" "customers_stage_kind" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers_activities" ADD CONSTRAINT "customers_activities_contact_id_customers_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customers_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_activities" ADD CONSTRAINT "customers_activities_company_id_customers_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."customers_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_activities" ADD CONSTRAINT "customers_activities_deal_id_customers_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."customers_deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_activities" ADD CONSTRAINT "customers_activities_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_companies" ADD CONSTRAINT "customers_companies_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_companies" ADD CONSTRAINT "customers_companies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_contacts" ADD CONSTRAINT "customers_contacts_company_id_customers_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."customers_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_contacts" ADD CONSTRAINT "customers_contacts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_contacts" ADD CONSTRAINT "customers_contacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_deals" ADD CONSTRAINT "customers_deals_contact_id_customers_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customers_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_deals" ADD CONSTRAINT "customers_deals_company_id_customers_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."customers_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_deals" ADD CONSTRAINT "customers_deals_stage_id_customers_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."customers_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_deals" ADD CONSTRAINT "customers_deals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_deals" ADD CONSTRAINT "customers_deals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_follow_ups" ADD CONSTRAINT "customers_follow_ups_contact_id_customers_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customers_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_follow_ups" ADD CONSTRAINT "customers_follow_ups_company_id_customers_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."customers_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_follow_ups" ADD CONSTRAINT "customers_follow_ups_deal_id_customers_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."customers_deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_follow_ups" ADD CONSTRAINT "customers_follow_ups_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_follow_ups" ADD CONSTRAINT "customers_follow_ups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers_saved_filters" ADD CONSTRAINT "customers_saved_filters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_activities_contact_idx" ON "customers_activities" USING btree ("contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customers_activities_company_idx" ON "customers_activities" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customers_activities_deal_idx" ON "customers_activities" USING btree ("deal_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customers_activities_search_idx" ON "customers_activities" USING gin ("search");--> statement-breakpoint
CREATE INDEX "customers_companies_search_idx" ON "customers_companies" USING gin ("search");--> statement-breakpoint
CREATE INDEX "customers_companies_tags_idx" ON "customers_companies" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "customers_companies_name_idx" ON "customers_companies" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "customers_contacts_search_idx" ON "customers_contacts" USING gin ("search");--> statement-breakpoint
CREATE INDEX "customers_contacts_tags_idx" ON "customers_contacts" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "customers_contacts_email_key_idx" ON "customers_contacts" USING btree ("email_key");--> statement-breakpoint
CREATE INDEX "customers_contacts_phone_key_idx" ON "customers_contacts" USING btree ("phone_key");--> statement-breakpoint
CREATE INDEX "customers_contacts_name_key_idx" ON "customers_contacts" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "customers_contacts_company_idx" ON "customers_contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "customers_deals_search_idx" ON "customers_deals" USING gin ("search");--> statement-breakpoint
CREATE INDEX "customers_deals_stage_idx" ON "customers_deals" USING btree ("stage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_fields_entity_key_idx" ON "customers_fields" USING btree ("entity","key");--> statement-breakpoint
CREATE INDEX "customers_follow_ups_due_idx" ON "customers_follow_ups" USING btree ("status","due_on");--> statement-breakpoint
CREATE INDEX "customers_follow_ups_assignee_idx" ON "customers_follow_ups" USING btree ("assignee_id","status");