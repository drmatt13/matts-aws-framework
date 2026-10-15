export interface DatabaseSettingsSources {
  readonly getContext: (key: string) => unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Application infrastructure policy, independent of workload connection declarations. */
export function resolveDatabaseSettings({ getContext, env }: DatabaseSettingsSources) {
  const read = (key: string): string | undefined => {
    const context = key.toLowerCase().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    for (const value of [getContext(context), env[key]]) {
      if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
    }
    return undefined;
  };
  const boolean = (key: string, fallback?: boolean): boolean | undefined => {
    const value = read(key)?.toLowerCase();
    if (value === undefined) return fallback;
    if (value !== "true" && value !== "false") throw new Error(`${key} must be "true" or "false".`);
    return value === "true";
  };
  const integer = (key: string, min: number, max: number, fallback?: number): number | undefined => {
    const value = read(key);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`${key} must be a whole number from ${min} to ${max}.`);
    }
    return parsed;
  };
  const instanceClass = (key: string, fallback: string): string => {
    const value = read(key) ?? fallback;
    if (!/^db\.[a-z][a-z0-9-]*\.(?:[a-z]+|\d+xlarge)$/.test(value)) throw new Error(`${key} must be an RDS instance class, such as db.t3.micro.`);
    return value;
  };
  const instance = instanceClass("DATABASE_INSTANCE_CLASS", "db.t3.micro");
  const replicaInstance = instanceClass("DATABASE_READ_REPLICA_INSTANCE_CLASS", instance);
  const engineVersion = read("DATABASE_ENGINE_VERSION") ?? "16";
  if (!/^[1-9]\d*(?:\.\d+)?$/.test(engineVersion)) throw new Error("DATABASE_ENGINE_VERSION must be a PostgreSQL major or major.minor version.");
  const storageType = read("DATABASE_STORAGE_TYPE") ?? "gp2";
  if (!["gp2", "gp3", "io2"].includes(storageType)) throw new Error("DATABASE_STORAGE_TYPE must be gp2, gp3, or io2.");
  const allocatedStorage = integer("DATABASE_ALLOCATED_STORAGE_GIB", storageType === "io2" ? 100 : 20, 65536, 20)!;
  // A default must satisfy the selected storage type too.
  if (storageType === "io2" && allocatedStorage < 100) throw new Error("DATABASE_ALLOCATED_STORAGE_GIB must be at least 100 for io2.");
  const maxAllocatedStorage = integer("DATABASE_MAX_ALLOCATED_STORAGE_GIB", 0, 65536, 100)!;
  if (maxAllocatedStorage !== 0 && maxAllocatedStorage < Math.ceil(allocatedStorage * 1.1)) {
    throw new Error("DATABASE_MAX_ALLOCATED_STORAGE_GIB must be 0 or at least 10% above DATABASE_ALLOCATED_STORAGE_GIB.");
  }
  const iops = integer("DATABASE_STORAGE_IOPS", 1000, 256000);
  const throughput = integer("DATABASE_STORAGE_THROUGHPUT_MIBPS", 125, 4000);
  if (storageType === "gp2" && (iops !== undefined || throughput !== undefined)) throw new Error("gp2 does not accept DATABASE_STORAGE_IOPS or DATABASE_STORAGE_THROUGHPUT_MIBPS.");
  if (storageType !== "gp3" && throughput !== undefined) throw new Error("DATABASE_STORAGE_THROUGHPUT_MIBPS applies only to gp3.");
  if (storageType === "gp3") {
    if (allocatedStorage < 400 && (iops !== undefined || throughput !== undefined)) throw new Error("Custom gp3 IOPS/throughput for PostgreSQL requires at least 400 GiB.");
    if (iops !== undefined && (iops < 12000 || iops > 64000 || iops > allocatedStorage * 500)) throw new Error("gp3 IOPS must be 12000–64000 and no more than 500 per GiB.");
    if (throughput !== undefined && (throughput < 500 || throughput > (iops ?? 12000) * 0.25)) throw new Error("gp3 throughput must be 500–4000 MiB/s and no more than 0.25 times IOPS.");
  }
  if (storageType === "io2") {
    if (iops === undefined) throw new Error("io2 requires DATABASE_STORAGE_IOPS.");
    // Known pre-Nitro families have the lower ratio; AWS validates regional/class availability.
    const preNitro = (value: string) => /^db\.(?:t2|m3|m4|r3|r4|x1|x1e)\./.test(value);
    const ratio = preNitro(instance) || preNitro(replicaInstance) ? 500 : 1000;
    if (iops > allocatedStorage * ratio || iops < (maxAllocatedStorage || allocatedStorage) * 0.5) throw new Error(`io2 IOPS/storage ratio must be 0.5–${ratio}, including the autoscaling ceiling.`);
  }
  const backupRetentionDays = integer("DATABASE_BACKUP_RETENTION_DAYS", 0, 35, 7)!;
  const readReplicaCount = integer("DATABASE_READ_REPLICA_COUNT", 0, 15, 0)!;
  if (readReplicaCount > 0 && backupRetentionDays === 0) throw new Error("DATABASE_READ_REPLICA_COUNT requires positive DATABASE_BACKUP_RETENTION_DAYS.");

  const time = (value: string): number => {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error("Database windows must use valid UTC HH:mm times.");
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const backupWindow = read("DATABASE_BACKUP_WINDOW");
  let backupStart: number | undefined;
  let backupLength = 0;
  if (backupWindow) {
    const parts = backupWindow.split("-");
    if (parts.length !== 2) throw new Error("DATABASE_BACKUP_WINDOW must be HH:mm-HH:mm in UTC.");
    backupStart = time(parts[0]!);
    backupLength = (time(parts[1]!) - backupStart + 1440) % 1440;
    if (backupLength < 30) throw new Error("DATABASE_BACKUP_WINDOW must be at least 30 minutes.");
  }
  const maintenanceWindow = read("DATABASE_MAINTENANCE_WINDOW");
  if (maintenanceWindow) {
    const match = /^(mon|tue|wed|thu|fri|sat|sun):(\d{2}:\d{2})-(mon|tue|wed|thu|fri|sat|sun):(\d{2}:\d{2})$/.exec(maintenanceWindow);
    if (!match) throw new Error("DATABASE_MAINTENANCE_WINDOW must be ddd:HH:mm-ddd:HH:mm in UTC.");
    const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const start = days.indexOf(match[1]!) * 1440 + time(match[2]!);
    const end = days.indexOf(match[3]!) * 1440 + time(match[4]!);
    const length = (end - start + 10080) % 10080;
    if (length < 30) throw new Error("DATABASE_MAINTENANCE_WINDOW must be at least 30 minutes.");
    if (backupStart !== undefined) {
      for (let minute = 0; minute < length; minute++) {
        if (((start + minute) % 1440 - backupStart + 1440) % 1440 < backupLength) throw new Error("DATABASE_BACKUP_WINDOW and DATABASE_MAINTENANCE_WINDOW must not overlap.");
      }
    }
  }
  const logExports = [...new Set((read("DATABASE_CLOUDWATCH_LOGS_EXPORTS") ?? "").split(",").map(v => v.trim()).filter(Boolean))];
  if (logExports.some(v => !["postgresql", "upgrade"].includes(v))) throw new Error("DATABASE_CLOUDWATCH_LOGS_EXPORTS accepts postgresql,upgrade.");
  const logRetentionDays = integer("DATABASE_LOG_RETENTION_DAYS", 1, 3653, 30)!;
  if (![1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653].includes(logRetentionDays)) throw new Error("DATABASE_LOG_RETENTION_DAYS must be a supported CloudWatch retention period.");
  return {
    instanceClass: instance, engineVersion, storageType: storageType as "gp2" | "gp3" | "io2",
    allocatedStorage, maxAllocatedStorage, iops, throughput, backupRetentionDays,
    backupWindow, maintenanceWindow, logExports, logRetentionDays,
    multiAz: boolean("DATABASE_MULTI_AZ", false)!,
    allowMajorVersionUpgrade: boolean("DATABASE_ALLOW_MAJOR_VERSION_UPGRADE", false)!,
    autoMinorVersionUpgrade: boolean("DATABASE_AUTO_MINOR_VERSION_UPGRADE", true)!,
    applyImmediately: boolean("DATABASE_APPLY_IMMEDIATELY"),
    readReplicaCount, readReplicaInstanceClass: replicaInstance,
    readReplicaMultiAz: boolean("DATABASE_READ_REPLICA_MULTI_AZ", false)!,
    proxyEnabled: boolean("DATABASE_PROXY_ENABLED", false)!,
    proxyMaxConnectionsPercent: integer("DATABASE_PROXY_MAX_CONNECTIONS_PERCENT", 1, 100, 90)!,
    proxyBorrowTimeoutSeconds: integer("DATABASE_PROXY_BORROW_TIMEOUT_SECONDS", 0, 3600, 15)!,
    proxyIdleClientTimeoutSeconds: integer("DATABASE_PROXY_IDLE_CLIENT_TIMEOUT_SECONDS", 1, 28800, 1800)!,
  };
}

export type DatabaseSettings = ReturnType<typeof resolveDatabaseSettings>;
