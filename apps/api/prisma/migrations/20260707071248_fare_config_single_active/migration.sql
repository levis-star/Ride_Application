-- Only one active FareConfig per vehicle class; historical (inactive) rows unlimited.
CREATE UNIQUE INDEX "FareConfig_one_active_per_class"
  ON "FareConfig" ("vehicleClass")
  WHERE "active";
