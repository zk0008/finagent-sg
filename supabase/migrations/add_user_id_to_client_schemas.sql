ALTER TABLE public.client_schemas
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id);
