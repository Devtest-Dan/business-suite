CREATE TABLE "announcements_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"author_id" uuid,
	"author_name" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"pinned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_key" text,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce("body", '')), 'B')) STORED,
	CONSTRAINT "announcements_posts_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "announcements_reads" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_reads_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "announcements_posts" ADD CONSTRAINT "announcements_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements_reads" ADD CONSTRAINT "announcements_reads_post_id_announcements_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."announcements_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements_reads" ADD CONSTRAINT "announcements_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_posts_search_idx" ON "announcements_posts" USING gin ("search");--> statement-breakpoint
CREATE INDEX "announcements_posts_created_idx" ON "announcements_posts" USING btree ("pinned","created_at");