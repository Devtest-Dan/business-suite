CREATE TYPE "public"."funnel_enrollment_status" AS ENUM('active', 'stopped', 'finished');--> statement-breakpoint
CREATE TYPE "public"."funnel_lead_source" AS ENUM('form', 'phone', 'walk_in', 'email', 'referral', 'import', 'other');--> statement-breakpoint
CREATE TYPE "public"."funnel_lead_status" AS ENUM('new', 'contacted', 'qualified', 'converted', 'disqualified');--> statement-breakpoint
CREATE TYPE "public"."funnel_send_status" AS ENUM('scheduled', 'sending', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "funnel_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"status" "funnel_enrollment_status" DEFAULT 'active' NOT NULL,
	"stop_reason" text DEFAULT '' NOT NULL,
	"approval_id" uuid,
	"source_key" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	CONSTRAINT "funnel_enrollments_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "funnel_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"heading" text DEFAULT '' NOT NULL,
	"fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"services" text[] DEFAULT '{}'::text[] NOT NULL,
	"consent_text" text NOT NULL,
	"thank_you_message" text DEFAULT '' NOT NULL,
	"redirect_url" text DEFAULT '' NOT NULL,
	"embed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"assignee_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funnel_forms_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "funnel_lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"author_id" uuid,
	"author_name" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"service" text DEFAULT '' NOT NULL,
	"contact_method" text DEFAULT '' NOT NULL,
	"status" "funnel_lead_status" DEFAULT 'new' NOT NULL,
	"disqualify_reason" text DEFAULT '' NOT NULL,
	"source" "funnel_lead_source" NOT NULL,
	"source_detail" text DEFAULT '' NOT NULL,
	"form_id" uuid,
	"page_url" text DEFAULT '' NOT NULL,
	"referrer" text DEFAULT '' NOT NULL,
	"utm_source" text DEFAULT '' NOT NULL,
	"utm_medium" text DEFAULT '' NOT NULL,
	"utm_campaign" text DEFAULT '' NOT NULL,
	"consent_text" text DEFAULT '' NOT NULL,
	"consent_at" timestamp with time zone,
	"assignee_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_contact_at" timestamp with time zone,
	"qualified_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"disqualified_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"customer_contact_id" text,
	"customer_deal_id" text,
	"conversion_approval_id" uuid,
	"conversion_attempt" integer DEFAULT 0 NOT NULL,
	"email_key" text DEFAULT '' NOT NULL,
	"phone_key" text DEFAULT '' NOT NULL,
	"source_key" text,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("name", '') || ' ' || coalesce("company", '')), 'A') || setweight(to_tsvector('simple', coalesce("email", '') || ' ' || coalesce("phone", '') || ' ' || coalesce("service", '')), 'B') || setweight(to_tsvector('simple', coalesce("message", '')), 'C')) STORED,
	CONSTRAINT "funnel_leads_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "funnel_rate_hits" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "funnel_rate_hits_bucket_window_start_pk" PRIMARY KEY("bucket","window_start")
);
--> statement-breakpoint
CREATE TABLE "funnel_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "funnel_send_status" DEFAULT 'scheduled' NOT NULL,
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"to_email" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "funnel_sequence_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"delay_days" integer NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"target_minutes" integer DEFAULT 15 NOT NULL,
	"postal_address" text DEFAULT '' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funnel_settings_one_row" CHECK ("funnel_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "funnel_enrollments" ADD CONSTRAINT "funnel_enrollments_lead_id_funnel_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."funnel_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_enrollments" ADD CONSTRAINT "funnel_enrollments_sequence_id_funnel_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."funnel_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_forms" ADD CONSTRAINT "funnel_forms_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_forms" ADD CONSTRAINT "funnel_forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_lead_events" ADD CONSTRAINT "funnel_lead_events_lead_id_funnel_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."funnel_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_lead_events" ADD CONSTRAINT "funnel_lead_events_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_leads" ADD CONSTRAINT "funnel_leads_form_id_funnel_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."funnel_forms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_leads" ADD CONSTRAINT "funnel_leads_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_leads" ADD CONSTRAINT "funnel_leads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_sends" ADD CONSTRAINT "funnel_sends_enrollment_id_funnel_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."funnel_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_sends" ADD CONSTRAINT "funnel_sends_step_id_funnel_sequence_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."funnel_sequence_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_sequence_steps" ADD CONSTRAINT "funnel_sequence_steps_sequence_id_funnel_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."funnel_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_sequences" ADD CONSTRAINT "funnel_sequences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_settings" ADD CONSTRAINT "funnel_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_enrollments_lead_sequence_idx" ON "funnel_enrollments" USING btree ("lead_id","sequence_id");--> statement-breakpoint
CREATE INDEX "funnel_enrollments_status_idx" ON "funnel_enrollments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "funnel_lead_events_lead_idx" ON "funnel_lead_events" USING btree ("lead_id","at");--> statement-breakpoint
CREATE INDEX "funnel_leads_status_idx" ON "funnel_leads" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "funnel_leads_assignee_idx" ON "funnel_leads" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "funnel_leads_created_idx" ON "funnel_leads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "funnel_leads_email_key_idx" ON "funnel_leads" USING btree ("email_key");--> statement-breakpoint
CREATE INDEX "funnel_leads_phone_key_idx" ON "funnel_leads" USING btree ("phone_key");--> statement-breakpoint
CREATE INDEX "funnel_leads_search_idx" ON "funnel_leads" USING gin ("search");--> statement-breakpoint
CREATE INDEX "funnel_rate_hits_window_idx" ON "funnel_rate_hits" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_sends_enrollment_step_idx" ON "funnel_sends" USING btree ("enrollment_id","step_id");--> statement-breakpoint
CREATE INDEX "funnel_sends_due_idx" ON "funnel_sends" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_sequence_steps_position_idx" ON "funnel_sequence_steps" USING btree ("sequence_id","position");