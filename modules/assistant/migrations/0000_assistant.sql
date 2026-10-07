CREATE TYPE "public"."assistant_fact_kind" AS ENUM('fact', 'preference', 'commitment', 'event', 'belief');--> statement-breakpoint
CREATE TYPE "public"."assistant_fact_source" AS ENUM('person', 'assistant', 'import', 'agent', 'brain', 'demo');--> statement-breakpoint
CREATE TYPE "public"."assistant_fact_status" AS ENUM('active', 'corrected', 'withdrawn');--> statement-breakpoint
CREATE TABLE "assistant_agents" (
	"client_id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "assistant_agents_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "assistant_brain_client" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"client_id" text NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_fact_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fact_id" uuid NOT NULL,
	"text" text NOT NULL,
	"by_name" text NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text NOT NULL,
	"kind" "assistant_fact_kind" DEFAULT 'fact' NOT NULL,
	"source" "assistant_fact_source" NOT NULL,
	"source_detail" text DEFAULT '' NOT NULL,
	"source_url" text,
	"status" "assistant_fact_status" DEFAULT 'active' NOT NULL,
	"gbrain_id" text,
	"agent_client_id" text,
	"created_by" uuid,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_reason" text,
	"brain_error" text,
	"source_key" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("text", '') || ' ' || coalesce("source_detail", ''))) STORED,
	CONSTRAINT "assistant_facts_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "assistant_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"monthly_token_cap" bigint,
	"monthly_spend_cap" numeric(12, 2),
	"price_per_million_in" numeric(12, 4),
	"price_per_million_out" numeric(12, 4),
	"currency" text DEFAULT 'USD' NOT NULL,
	"redact_facts" boolean DEFAULT true NOT NULL,
	"notified_month" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_usage" (
	"month" text NOT NULL,
	"user_id" uuid NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "assistant_usage_month_user_id_pk" PRIMARY KEY("month","user_id")
);
--> statement-breakpoint
ALTER TABLE "assistant_agents" ADD CONSTRAINT "assistant_agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_fact_versions" ADD CONSTRAINT "assistant_fact_versions_fact_id_assistant_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."assistant_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_facts" ADD CONSTRAINT "assistant_facts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_settings" ADD CONSTRAINT "assistant_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD CONSTRAINT "assistant_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_fact_versions_fact_idx" ON "assistant_fact_versions" USING btree ("fact_id","replaced_at");--> statement-breakpoint
CREATE INDEX "assistant_facts_search_idx" ON "assistant_facts" USING gin ("search");--> statement-breakpoint
CREATE INDEX "assistant_facts_status_idx" ON "assistant_facts" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "assistant_facts_gbrain_idx" ON "assistant_facts" USING btree ("gbrain_id");