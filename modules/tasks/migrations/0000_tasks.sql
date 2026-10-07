CREATE TYPE "public"."tasks_project_visibility" AS ENUM('team', 'private');--> statement-breakpoint
CREATE TYPE "public"."tasks_reminder_kind" AS ENUM('due_today', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."tasks_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."tasks_recurrence" AS ENUM('none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."tasks_status" AS ENUM('todo', 'doing', 'waiting', 'done');--> statement-breakpoint
CREATE TABLE "tasks_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks_assignees" (
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "tasks_assignees_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tasks_attachments" (
	"task_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_attachments_task_id_file_id_pk" PRIMARY KEY("task_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "tasks_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"text" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author_id" uuid,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks_project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tasks_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"visibility" "tasks_project_visibility" DEFAULT 'team' NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("name", '')), 'A') || setweight(to_tsvector('simple', coalesce("description", '')), 'B')) STORED
);
--> statement-breakpoint
CREATE TABLE "tasks_reminders" (
	"task_id" uuid NOT NULL,
	"kind" "tasks_reminder_kind" NOT NULL,
	"due_on" date NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_reminders_task_id_kind_due_on_pk" PRIMARY KEY("task_id","kind","due_on")
);
--> statement-breakpoint
CREATE TABLE "tasks_watchers" (
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "tasks_watchers_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tasks_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "tasks_status" DEFAULT 'todo' NOT NULL,
	"priority" "tasks_priority" DEFAULT 'normal' NOT NULL,
	"due_on" date,
	"due_offset_days" integer,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"recurrence" "tasks_recurrence" DEFAULT 'none' NOT NULL,
	"recurrence_of" uuid,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_label" text,
	"source_url" text,
	"external_id" text,
	"external_updated_at" timestamp with time zone,
	"source_key" text,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce("description", '')), 'B')) STORED,
	CONSTRAINT "tasks_tasks_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
ALTER TABLE "tasks_activity" ADD CONSTRAINT "tasks_activity_task_id_tasks_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_activity" ADD CONSTRAINT "tasks_activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_assignees" ADD CONSTRAINT "tasks_assignees_task_id_tasks_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_assignees" ADD CONSTRAINT "tasks_assignees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_attachments" ADD CONSTRAINT "tasks_attachments_task_id_tasks_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_attachments" ADD CONSTRAINT "tasks_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_attachments" ADD CONSTRAINT "tasks_attachments_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_checklist_items" ADD CONSTRAINT "tasks_checklist_items_task_id_tasks_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_comments" ADD CONSTRAINT "tasks_comments_task_id_tasks_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_comments" ADD CONSTRAINT "tasks_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_project_members" ADD CONSTRAINT "tasks_project_members_project_id_tasks_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."tasks_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_project_members" ADD CONSTRAINT "tasks_project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_projects" ADD CONSTRAINT "tasks_projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_reminders" ADD CONSTRAINT "tasks_reminders_task_id_tasks_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_watchers" ADD CONSTRAINT "tasks_watchers_task_id_tasks_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_watchers" ADD CONSTRAINT "tasks_watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_tasks" ADD CONSTRAINT "tasks_tasks_project_id_tasks_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."tasks_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_tasks" ADD CONSTRAINT "tasks_tasks_recurrence_of_tasks_tasks_id_fk" FOREIGN KEY ("recurrence_of") REFERENCES "public"."tasks_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_tasks" ADD CONSTRAINT "tasks_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_activity_task_idx" ON "tasks_activity" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_assignees_user_idx" ON "tasks_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_checklist_task_idx" ON "tasks_checklist_items" USING btree ("task_id","position");--> statement-breakpoint
CREATE INDEX "tasks_comments_task_idx" ON "tasks_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_project_members_user_idx" ON "tasks_project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_projects_search_idx" ON "tasks_projects" USING gin ("search");--> statement-breakpoint
CREATE INDEX "tasks_projects_list_idx" ON "tasks_projects" USING btree ("is_template","archived","name");--> statement-breakpoint
CREATE INDEX "tasks_tasks_search_idx" ON "tasks_tasks" USING gin ("search");--> statement-breakpoint
CREATE INDEX "tasks_tasks_project_idx" ON "tasks_tasks" USING btree ("project_id","status","position");--> statement-breakpoint
CREATE INDEX "tasks_tasks_due_idx" ON "tasks_tasks" USING btree ("due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_tasks_recurrence_of_idx" ON "tasks_tasks" USING btree ("recurrence_of");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_tasks_external_idx" ON "tasks_tasks" USING btree ("external_id");