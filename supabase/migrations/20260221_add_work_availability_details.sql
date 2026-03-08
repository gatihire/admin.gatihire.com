alter table candidates
  add column if not exists available_start_date date,
  add column if not exists availability_notes text;
