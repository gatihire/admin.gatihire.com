-- Update department_category check constraint to include all new logistics/supply chain categories
do $$
begin
  -- Drop existing constraint if it exists
  if exists (
    select 1 from pg_constraint where conname = 'jobs_department_category_chk'
  ) then
    execute 'alter table jobs drop constraint jobs_department_category_chk';
  end if;

  -- Add updated constraint with all department categories
  execute 'alter table jobs add constraint jobs_department_category_chk check (department_category is null or department_category in (
    ''operations'',
    ''fleet'',
    ''dispatch'',
    ''warehouse'',
    ''transportation'',
    ''supply_chain'',
    ''procurement'',
    ''customer_service'',
    ''safety_compliance'',
    ''maintenance'',
    ''quality_control'',
    ''inventory'',
    ''freight_forwarding'',
    ''cold_chain'',
    ''sales'',
    ''accounts_finance'',
    ''hr_admin'',
    ''it_technology''
  ))';
end $$;

-- Update role_category check constraint to include all new logistics/supply chain categories
do $$
begin
  -- Drop existing constraint if it exists
  if exists (
    select 1 from pg_constraint where conname = 'jobs_role_category_chk'
  ) then
    execute 'alter table jobs drop constraint jobs_role_category_chk';
  end if;

  -- Add updated constraint with all role categories
  execute 'alter table jobs add constraint jobs_role_category_chk check (role_category is null or role_category in (
    ''last_mile_delivery'',
    ''line_haul'',
    ''long_haul'',
    ''warehouse_operations'',
    ''fleet_operations'',
    ''transportation_driver'',
    ''dispatch_coordination'',
    ''supply_chain_planning'',
    ''procurement'',
    ''customer_service_logistics'',
    ''safety_compliance'',
    ''maintenance_technician'',
    ''quality_control'',
    ''inventory_management'',
    ''freight_forwarding'',
    ''cold_chain'',
    ''sales_bd'',
    ''accounts_exec_assistant'',
    ''hr_admin'',
    ''it_technology''
  ))';
end $$;

-- Update sub_category check constraint to include new sub categories
do $$
begin
  -- Drop existing constraint if it exists
  if exists (
    select 1 from pg_constraint where conname = 'jobs_sub_category_chk'
  ) then
    execute 'alter table jobs drop constraint jobs_sub_category_chk';
  end if;

  -- Add updated constraint with all sub categories
  execute 'alter table jobs add constraint jobs_sub_category_chk check (sub_category is null or sub_category in (
    ''driver_heavy_vehicle'',
    ''driver_light_commercial'',
    ''driver_last_mile'',
    ''driver_line_haul'',
    ''dispatcher'',
    ''transport_coordinator'',
    ''route_planner'',
    ''warehouse_staff'',
    ''warehouse_supervisor'',
    ''inventory_executive'',
    ''picker_packer'',
    ''loader_unloader'',
    ''forklift_operator'',
    ''qc_executive'',
    ''fleet_manager'',
    ''fleet_supervisor'',
    ''fleet_maintenance'',
    ''operations_executive'',
    ''operations_manager'',
    ''customer_support'',
    ''sales_3pl'',
    ''ptl_sales'',
    ''delivery_associate'',
    ''accounts_finance'',
    ''other''
  ))';
end $$;