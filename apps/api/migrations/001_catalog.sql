-- SlotFlow M1: catalog + multi-tenancy (Row Level Security on every table)
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'slotflow_app') THEN
    -- Application role: never superuser, never BYPASSRLS, so RLS always applies. Dev password only.
    CREATE ROLE slotflow_app LOGIN PASSWORD 'slotflow_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- Current tenant, set per transaction by the API (SET LOCAL semantics). NULL when unset => no rows visible.
CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','manager','staff','customer')),
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (id, tenant_id)
);

CREATE TABLE branches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  timezone   text NOT NULL,            -- IANA, e.g. Asia/Ho_Chi_Minh
  address    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE manager_branches (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id(),
  user_id   uuid NOT NULL,
  branch_id uuid NOT NULL,
  PRIMARY KEY (user_id, branch_id),
  FOREIGN KEY (user_id, tenant_id)   REFERENCES users(id, tenant_id)    ON DELETE CASCADE,
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE staff (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  full_name  text NOT NULL,
  title      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE services (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  name                    text NOT NULL,
  duration_min            int  NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  buffer_before_min       int  NOT NULL DEFAULT 0 CHECK (buffer_before_min >= 0),
  buffer_after_min        int  NOT NULL DEFAULT 0 CHECK (buffer_after_min >= 0),
  price_cents             int  NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  cancel_window_hours     int  NOT NULL DEFAULT 24 CHECK (cancel_window_hours >= 0),
  requires_resource_type  text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE staff_branches (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id(),
  staff_id  uuid NOT NULL,
  branch_id uuid NOT NULL,
  PRIMARY KEY (staff_id, branch_id),
  FOREIGN KEY (staff_id, tenant_id)  REFERENCES staff(id, tenant_id)    ON DELETE CASCADE,
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE staff_services (
  tenant_id  uuid NOT NULL DEFAULT app_tenant_id(),
  staff_id   uuid NOT NULL,
  service_id uuid NOT NULL,
  PRIMARY KEY (staff_id, service_id),
  FOREIGN KEY (staff_id, tenant_id)   REFERENCES staff(id, tenant_id)    ON DELETE CASCADE,
  FOREIGN KEY (service_id, tenant_id) REFERENCES services(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE resources (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id  uuid NOT NULL,
  type       text NOT NULL,           -- room | dental_chair | ultrasound ...
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX resources_branch_idx ON resources (branch_id, type);

-- Working hours are stored in the branch's LOCAL time so DST shifts are handled when converting to UTC.
CREATE TABLE working_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  owner_type  text NOT NULL CHECK (owner_type IN ('branch','staff')),
  owner_id    uuid NOT NULL,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1=Mon .. 7=Sun
  start_local time NOT NULL,
  end_local   time NOT NULL,
  CHECK (end_local > start_local)
);
CREATE INDEX working_hours_owner_idx ON working_hours (owner_type, owner_id, weekday);

CREATE TABLE time_off (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  owner_type text NOT NULL CHECK (owner_type IN ('branch','staff')),
  owner_id   uuid NOT NULL,
  start_at   timestamptz NOT NULL,
  end_at     timestamptz NOT NULL,
  range      tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at)) STORED,
  reason     text,
  CHECK (end_at > start_at)
);
CREATE INDEX time_off_owner_idx ON time_off USING gist (owner_id, range);

CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  full_name  text NOT NULL,
  email      text,
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX customers_email_uq ON customers (tenant_id, email) WHERE email IS NOT NULL;

-- Tenant isolation: enabled AND forced on every table; policy fails closed when app.tenant_id is unset.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['users','branches','manager_branches','staff','services','staff_branches',
    'staff_services','resources','working_hours','time_off','customers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO slotflow_app;
GRANT SELECT ON tenants TO slotflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, branches, manager_branches, staff, services,
  staff_branches, staff_services, resources, working_hours, time_off, customers TO slotflow_app;
