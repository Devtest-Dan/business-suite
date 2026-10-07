CREATE TYPE "public"."chat_channel_kind" AS ENUM('public', 'private', 'dm', 'group');--> statement-breakpoint
CREATE TYPE "public"."chat_notify_level" AS ENUM('all', 'mentions', 'none');--> statement-breakpoint
CREATE TYPE "public"."chat_via" AS ENUM('user', 'ai', 'import');--> statement-breakpoint
CREATE SEQUENCE "public"."chat_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "chat_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "chat_channel_kind" NOT NULL,
	"name" text,
	"topic" text DEFAULT '' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"dm_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"import_key" text,
	CONSTRAINT "chat_channels_name_unique" UNIQUE("name"),
	CONSTRAINT "chat_channels_dm_key_unique" UNIQUE("dm_key"),
	CONSTRAINT "chat_channels_import_key_unique" UNIQUE("import_key")
);
--> statement-breakpoint
CREATE TABLE "chat_members" (
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_cseq" bigint DEFAULT 0 NOT NULL,
	"notify" "chat_notify_level" DEFAULT 'mentions' NOT NULL,
	CONSTRAINT "chat_members_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"parent_id" uuid,
	"author_id" uuid,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"mentioned_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"mentions_channel" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"link_preview" jsonb,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"pinned_at" timestamp with time zone,
	"pinned_by" uuid,
	"via" "chat_via" DEFAULT 'user' NOT NULL,
	"cseq" bigint DEFAULT nextval('chat_seq') NOT NULL,
	"seq" bigint DEFAULT nextval('chat_seq') NOT NULL,
	"source_key" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("body", ''))) STORED,
	CONSTRAINT "chat_messages_cseq_unique" UNIQUE("cseq"),
	CONSTRAINT "chat_messages_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "chat_people" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"defaults_joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "chat_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"preview_hosts" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_people" ADD CONSTRAINT "chat_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reactions" ADD CONSTRAINT "chat_reactions_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reactions" ADD CONSTRAINT "chat_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_channels_kind_idx" ON "chat_channels" USING btree ("kind","archived_at");--> statement-breakpoint
CREATE INDEX "chat_members_user_idx" ON "chat_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_messages_channel_idx" ON "chat_messages" USING btree ("channel_id","parent_id","cseq");--> statement-breakpoint
CREATE INDEX "chat_messages_seq_idx" ON "chat_messages" USING btree ("channel_id","seq");--> statement-breakpoint
CREATE INDEX "chat_messages_parent_idx" ON "chat_messages" USING btree ("parent_id","cseq");--> statement-breakpoint
CREATE INDEX "chat_messages_search_idx" ON "chat_messages" USING gin ("search");