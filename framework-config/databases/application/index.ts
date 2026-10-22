import { defineDatabase } from "@repo/framework/config";
import { resources } from "../../resources";
import { applicationVpc } from "../../networks/application";

/**
 * The primary database used by database: true. Production owns the existing RDS
 * instance; local development keeps using Compose PostgreSQL. This declaration
 * changes settings, never its deployed stack or construct identity.
 *
 * DATABASE_* deployment inputs and matching CDK context remain explicit
 * overrides. Removing an override lets this declaration supply the setting.
 */
export const applicationDatabase = defineDatabase({
  id: "application",
  tags: { area: "database" },
  resource: resources.rds.database,
  vpc: applicationVpc,
  subnet: "isolated",
  engine: "postgres",
  databaseName: "app_db",
  settings: {
    engineVersion: "16",
    instanceClass: "db.t3.micro",
    storageType: "gp2",
    allocatedStorage: 20,
    maxAllocatedStorage: 100,
    backupRetentionDays: 7,
    multiAz: false,
    readReplicaCount: 0,
    proxyEnabled: false,
  },
});
