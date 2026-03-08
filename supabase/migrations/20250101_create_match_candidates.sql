-- Enable the pgvector extension to work with embedding vectors
create extension if not exists vector;

-- Add embedding column to candidates table if it doesn't exist
alter table candidates add column if not exists embedding vector(1536);

-- Create index for faster vector search if it doesn't exist
create index if not exists candidates_embedding_idx on candidates using ivfflat (embedding vector_cosine_ops);

-- Create the match_candidates function for vector search
create or replace function match_candidates (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    candidates.id,
    1 - (candidates.embedding <=> query_embedding) as similarity
  from candidates
  where 1 - (candidates.embedding <=> query_embedding) > match_threshold
  order by candidates.embedding <=> query_embedding
  limit match_count;
end;
$$;
