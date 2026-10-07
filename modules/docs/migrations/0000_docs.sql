CREATE TABLE "docs_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_attachments_page_file_unique" UNIQUE("page_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "docs_links" (
	"from_page_id" uuid NOT NULL,
	"to_page_id" uuid NOT NULL,
	CONSTRAINT "docs_links_from_page_id_to_page_id_pk" PRIMARY KEY("from_page_id","to_page_id")
);
--> statement-breakpoint
CREATE TABLE "docs_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'page' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schedule" text DEFAULT 'none' NOT NULL,
	"schedule_day" smallint,
	"is_template" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"updated_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"import_path" text,
	"source_key" text,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce("body", '')), 'B') || setweight(jsonb_to_tsvector('simple', "steps", '["string"]'), 'B')) STORED,
	CONSTRAINT "docs_pages_source_key_unique" UNIQUE("source_key"),
	CONSTRAINT "docs_pages_space_import_path_unique" UNIQUE("space_id","import_path")
);
--> statement-breakpoint
CREATE TABLE "docs_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"kind" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"edited_by" uuid,
	"edited_by_name" text NOT NULL,
	"via" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_revisions_page_revision_unique" UNIQUE("page_id","revision")
);
--> statement-breakpoint
CREATE TABLE "docs_run_steps" (
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"done_by" uuid,
	"done_by_name" text NOT NULL,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	CONSTRAINT "docs_run_steps_run_id_position_pk" PRIMARY KEY("run_id","position")
);
--> statement-breakpoint
CREATE TABLE "docs_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"steps" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"due_on" date NOT NULL,
	"assigned_to" uuid,
	"started_by" uuid,
	"started_by_name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by" uuid,
	"completed_by_name" text,
	"completed_at" timestamp with time zone,
	"flagged" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_space_members" (
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_space_members_space_id_user_id_pk" PRIMARY KEY("space_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "docs_spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'team' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "docs_attachments" ADD CONSTRAINT "docs_attachments_page_id_docs_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."docs_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_attachments" ADD CONSTRAINT "docs_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_attachments" ADD CONSTRAINT "docs_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_links" ADD CONSTRAINT "docs_links_from_page_id_docs_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."docs_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_links" ADD CONSTRAINT "docs_links_to_page_id_docs_pages_id_fk" FOREIGN KEY ("to_page_id") REFERENCES "public"."docs_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_pages" ADD CONSTRAINT "docs_pages_space_id_docs_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."docs_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_pages" ADD CONSTRAINT "docs_pages_parent_id_docs_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."docs_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_pages" ADD CONSTRAINT "docs_pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_pages" ADD CONSTRAINT "docs_pages_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_revisions" ADD CONSTRAINT "docs_revisions_page_id_docs_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."docs_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_revisions" ADD CONSTRAINT "docs_revisions_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_run_steps" ADD CONSTRAINT "docs_run_steps_run_id_docs_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."docs_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_run_steps" ADD CONSTRAINT "docs_run_steps_done_by_users_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_runs" ADD CONSTRAINT "docs_runs_page_id_docs_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."docs_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_runs" ADD CONSTRAINT "docs_runs_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_runs" ADD CONSTRAINT "docs_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_runs" ADD CONSTRAINT "docs_runs_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_space_members" ADD CONSTRAINT "docs_space_members_space_id_docs_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."docs_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_space_members" ADD CONSTRAINT "docs_space_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs_spaces" ADD CONSTRAINT "docs_spaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docs_attachments_page_idx" ON "docs_attachments" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "docs_links_to_idx" ON "docs_links" USING btree ("to_page_id");--> statement-breakpoint
CREATE INDEX "docs_pages_search_idx" ON "docs_pages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "docs_pages_space_parent_idx" ON "docs_pages" USING btree ("space_id","parent_id");--> statement-breakpoint
CREATE INDEX "docs_pages_updated_idx" ON "docs_pages" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "docs_runs_page_idx" ON "docs_runs" USING btree ("page_id","due_on");--> statement-breakpoint
CREATE INDEX "docs_runs_status_idx" ON "docs_runs" USING btree ("status","assigned_to");--> statement-breakpoint
CREATE INDEX "docs_space_members_user_idx" ON "docs_space_members" USING btree ("user_id");