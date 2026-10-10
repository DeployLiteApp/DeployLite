ALTER TABLE transport_port_reservations
  ADD COLUMN port_transfer jsonb;

ALTER TABLE transport_port_reservations
  ADD CONSTRAINT transport_port_reservations_transfer_object
  CHECK (port_transfer IS NULL OR jsonb_typeof(port_transfer) = 'object');
