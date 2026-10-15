-- MahiFrame only: isolated metadata tables. This script does not alter existing app tables.
-- Run in the Supabase SQL Editor for the project used by MahiFrame.

create extension if not exists pgcrypto;

create table if not exists public.mf_profile (
  id integer primary key default 1 check (id = 1),
  name text not null default 'MahiFrame',
  handle text not null default '@mahimahfud',
  bio text not null default 'Short films. Small moments. Original quality.',
  avatar_url text not null default '',
  location text not null default '',
  socials jsonb not null default '[]'::jsonb,
  categories jsonb not null default '[]'::jsonb,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mf_videos (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Untitled video' check (char_length(title) between 1 and 120),
  description text not null default '',
  category text not null default '',
  original_name text not null,
  mime text not null check (mime in ('video/mp4', 'video/quicktime', 'video/webm')),
  size bigint not null check (size > 0),
  width integer,
  height integer,
  duration numeric(10,3),
  original_key text not null unique,
  thumb_key text unique,
  upload_id text,
  storage_etag text,
  status text not null default 'uploading'
    check (status in ('uploading', 'ready', 'failed')),
  published boolean not null default false,
  featured boolean not null default false,
  position integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mf_videos_public_order
  on public.mf_videos (position, created_at desc)
  where published = true and status = 'ready';

create index if not exists mf_videos_status_created
  on public.mf_videos (status, created_at desc);

alter table public.mf_profile enable row level security;
alter table public.mf_videos enable row level security;

-- All metadata access goes through the server API. The service role bypasses RLS;
-- browser clients may use Supabase Auth, but cannot read or modify these tables directly.
revoke all on table public.mf_profile from anon, authenticated;
revoke all on table public.mf_videos from anon, authenticated;

insert into public.mf_profile (id, name, handle, bio)
values (1, 'MahiFrame', '@mahimahfud', 'Short films. Small moments. Original quality.')
on conflict (id) do nothing;
