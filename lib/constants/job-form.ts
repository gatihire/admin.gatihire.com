export const BASE_SKILL_SUGGESTIONS = [
  "Dispatch",
  "TMS",
  "Fleet operations",
  "Warehouse operations",
  "Load planning",
  "Brokerage",
  "Customer support",
  "Excel",
  "GPS",
  "Safety compliance",
  "DOT compliance",
  "Supply chain",
  "Transportation",
  "Logistics",
  "Last-mile",
  "Route optimization",
] as const

export const SKILL_SUGGESTIONS_BY_SUBCATEGORY: Record<string, readonly string[]> = {
  "Car Carrier": ["Auto transport", "Load securement", "Vehicle inspection", "Damage documentation", "ELD", "DOT compliance"],
  "Dry Van": ["Dock operations", "Trailer management", "Appointment scheduling", "Load planning", "ELD", "DOT compliance"],
  Reefer: ["Temperature monitoring", "Cold chain", "Reefer unit basics", "ELD", "DOT compliance"],
  Flatbed: ["Straps & chains", "Load securement", "Tarps", "Oversize permits", "ELD", "DOT compliance"],
  Tanker: ["Tank cleaning", "Hazmat basics", "Safety compliance", "ELD", "DOT compliance"],
  Hazmat: ["Hazmat", "Safety compliance", "Documentation", "ELD", "DOT compliance"],
  Intermodal: ["Port operations", "Chassis management", "Drayage", "Appointment scheduling"],
  "Last Mile": ["Delivery routing", "Customer experience", "Proof of delivery", "Route optimization"],
  LTL: ["Dock scheduling", "Freight classification", "Claims handling", "Operations coordination"],
  Warehousing: ["WMS", "Inventory control", "Inbound/outbound", "Cycle counting", "Excel"],
  Dispatch: ["Dispatch", "TMS", "Route planning", "Driver support", "Customer support"],
  "Fleet Maintenance": ["Preventive maintenance", "Compliance", "Parts coordination", "Vendor management"],
  Other: [],
}

export const SUB_CATEGORY_OPTIONS = [
  { value: "driver_heavy_vehicle", label: "Driver – Heavy Vehicle" },
  { value: "driver_light_commercial", label: "Driver – Light Commercial" },
  { value: "driver_last_mile", label: "Driver – Last Mile / Delivery" },
  { value: "driver_line_haul", label: "Driver – Line Haul" },
  { value: "dispatcher", label: "Dispatcher" },
  { value: "transport_coordinator", label: "Transport Coordinator" },
  { value: "route_planner", label: "Route Planner" },
  { value: "warehouse_staff", label: "Warehouse Staff" },
  { value: "warehouse_supervisor", label: "Warehouse Supervisor" },
  { value: "inventory_executive", label: "Inventory Executive" },
  { value: "picker_packer", label: "Picker / Packer" },
  { value: "loader_unloader", label: "Loader / Unloader" },
  { value: "forklift_operator", label: "Forklift Operator" },
  { value: "qc_executive", label: "QC Executive" },
  { value: "fleet_manager", label: "Fleet Manager" },
  { value: "fleet_supervisor", label: "Fleet Supervisor" },
  { value: "fleet_maintenance", label: "Fleet Maintenance Technician" },
  { value: "operations_executive", label: "Operations Executive" },
  { value: "operations_manager", label: "Operations Manager" },
  { value: "customer_support", label: "Customer Support" },
  { value: "sales_3pl", label: "3PL Sales" },
  { value: "delivery_associate", label: "Delivery Associate" }
] as const

export const LANGUAGE_OPTIONS = ["Hindi", "English", "Regional"] as const

export const ENGLISH_LEVEL_OPTIONS = [
  { value: "no_english", label: "No English" },
  { value: "basic", label: "Basic" },
  { value: "good", label: "Good English" },
] as const

export const EDUCATION_MIN_OPTIONS = [
  { value: "no_formal", label: "No Formal Education" },
  { value: "8th", label: "8th Pass" },
  { value: "10th", label: "10th Pass" },
  { value: "12th", label: "12th Pass" },
  { value: "graduate", label: "Graduate" },
] as const

export const EXPERIENCE_TYPE_OPTIONS = [
  { value: "fresher", label: "Fresher" },
  { value: "experienced", label: "Experienced" },
] as const

export const EXPERIENCE_CATEGORY_OPTIONS = [
  { value: "heavy_vehicle", label: "Heavy Vehicle" },
  { value: "fleet_ops", label: "Fleet Ops" },
  { value: "warehouse", label: "Warehouse" },
  { value: "dispatch", label: "Dispatch" },
] as const

export const LICENSE_TYPE_OPTIONS = [
  { value: "lmv", label: "LMV" },
  { value: "hmv", label: "HMV" },
  { value: "mcwg", label: "MCWG" },
  { value: "not_required", label: "Not Required" },
] as const

export const CERT_OPTIONS = ["Forklift", "Safety Training", "GPS/TMS Knowledge"] as const

export const GENDER_PREFERENCE_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
] as const

export const ROLE_CATEGORY_OPTIONS = [
  { value: "last_mile_delivery", label: "Last Mile Delivery" },
  { value: "line_haul", label: "Line Haul" },
  { value: "long_haul", label: "Long Haul" },
  { value: "warehouse_operations", label: "Warehouse Operations" },
  { value: "fleet_operations", label: "Fleet Operations" },
] as const

export const DEPARTMENT_CATEGORY_OPTIONS = [
  { value: "operations", label: "Operations" },
  { value: "fleet", label: "Fleet" },
  { value: "dispatch", label: "Dispatch" },
  { value: "warehouse", label: "Warehouse" },
] as const

export const WORK_TYPE_OPTIONS = [
  { value: "on_road", label: "On-road" },
  { value: "on_site", label: "On-site" },
  { value: "hybrid", label: "Hybrid" },
] as const

export const REPORTING_TO_OPTIONS = [
  { value: "supervisor", label: "Supervisor" },
  { value: "fleet_manager", label: "Fleet Manager" },
  { value: "operations_head", label: "Operations Head" },
] as const

export const WHY_JOIN_OPTIONS = ["Stable income", "Fixed route", "Overtime pay", "Growth opportunity"] as const
export const BENEFIT_OPTIONS = ["PF / ESIC", "Fuel Allowance", "Incentives", "Accommodation", "Food"] as const
