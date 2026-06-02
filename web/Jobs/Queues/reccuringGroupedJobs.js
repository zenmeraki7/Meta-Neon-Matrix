import logger from "../../utils/loggerUtils.js";

const DEPRECATED_MESSAGE =
  "Legacy recurring grouped queue is retired. Use recurringEditSchedulerWorker + recurringEditExecutionService.";

export const timeSlots = [];

export const registerGroupedRecurringJobs = async () => {
  logger.warn(DEPRECATED_MESSAGE, {
    module: "reccuringGroupedJobs",
    action: "registerGroupedRecurringJobs",
  });
  return { retired: true };
};

export const listRegisteredJobs = async () => {
  logger.warn(DEPRECATED_MESSAGE, {
    module: "reccuringGroupedJobs",
    action: "listRegisteredJobs",
  });
  return { retired: true, totalJobs: 0, repeatableJobs: 0 };
};

export const clearAllJobs = async () => {
  logger.warn(DEPRECATED_MESSAGE, {
    module: "reccuringGroupedJobs",
    action: "clearAllJobs",
  });
  return { retired: true };
};

