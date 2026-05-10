import { createService } from "./firestoreBase";

export const faenasService = createService("faena", "faenas");
export const subfaenasService = createService("subfaena", "subfaenas");
export const cyclesService = createService("cycle", "cycles");
export const workersService = createService("worker", "worker");
export const workdaysService = createService("workday", "workdays");
export const groupLeadersService = createService("groupLeader", "groupLeader");
export { tripsService as transportsService, paymentsService as transportPaymentsService } from "./transportsService";
export const logsService = createService("log", "logs");

export { logAction } from "./logger";
