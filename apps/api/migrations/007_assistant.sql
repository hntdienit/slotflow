-- SlotFlow M6: AI booking assistant. The conversation state lives in the database (not in the client)
-- so the confirmation step cannot be skipped by forging a request: the server remembers what it proposed.
CREATE TABLE assistant_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  state       jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  UNIQUE (id, tenant_id),
  FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX assistant_conversations_customer_idx ON assistant_conversations (customer_id, updated_at DESC);

ALTER TABLE assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant_conversations
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_conversations TO slotflow_app;
