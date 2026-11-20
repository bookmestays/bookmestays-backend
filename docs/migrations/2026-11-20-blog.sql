-- Blog system (2026-11-20). Additive only — no existing data is changed or removed.
-- Equivalent to running `bun run db:push` with the current src/db/schema.ts.
-- Apply once:  psql "$DATABASE_URL" -f docs/migrations/2026-11-20-blog.sql
-- (ALTER TYPE ... ADD VALUE cannot run inside a transaction block on older Postgres, so no BEGIN/COMMIT.)

-- New role for the hired content writer (admin panel → Blog section only)
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'BLOG_EDITOR';
-- Blog images (cover + inline) uploaded through /media/presign
ALTER TYPE public.media_owner_type ADD VALUE IF NOT EXISTS 'BLOG';

DO $$ BEGIN
  CREATE TYPE public.blog_status AS ENUM ('DRAFT', 'PUBLISHED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.blog_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    title character varying(200) NOT NULL,
    slug character varying(220) NOT NULL CONSTRAINT blog_posts_slug_unique UNIQUE,
    previous_slugs text[] DEFAULT '{}'::text[] NOT NULL,
    excerpt character varying(500),
    content text DEFAULT ''::text NOT NULL,
    cover_image_url text,
    cover_image_alt character varying(200),
    category character varying(80),
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    city_id uuid CONSTRAINT blog_posts_city_id_cities_id_fk REFERENCES public.cities(id) ON DELETE SET NULL,
    status public.blog_status DEFAULT 'DRAFT'::public.blog_status NOT NULL,
    published_at timestamp with time zone,
    is_featured boolean DEFAULT false NOT NULL,
    reading_minutes integer DEFAULT 1 NOT NULL,
    author_id uuid CONSTRAINT blog_posts_author_id_users_id_fk REFERENCES public.users(id) ON DELETE SET NULL,
    author_name character varying(160),
    seo jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS blog_posts_category_idx ON public.blog_posts USING btree (category);
CREATE INDEX IF NOT EXISTS blog_posts_status_idx ON public.blog_posts USING btree (status, published_at);
