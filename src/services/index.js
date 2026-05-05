import { createService } from "./firestoreBase";

export const faenasService = createService("faena", "faenas");
export const subfaenasService = createService("subfaena", "subfaenas");
export const harvestsService = createService("harvest", "harvests");
export const cyclesService = createService("cycle", "cycles");
export const workersService = createService("worker", "worker");
export const workdaysService = createService("workday", "workdays");
export { tripsService as transportsService, paymentsService as transportPaymentsService } from "./transportsService";
export const logsService = createService("log", "logs");

export { logAction } from "./logger";
