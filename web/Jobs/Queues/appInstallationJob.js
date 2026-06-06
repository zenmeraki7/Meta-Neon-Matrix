import { appInstallationQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
  buildDefaultJobOptions,
  mergeJobOptions,
  joinSafeJobId,

} from "../../utils/jobQueueUtils.js";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 5,
  priority: 5,
  backoffDelay: 10_000,
  removeOnComplete: { age: 48 * 3600, count: 500 },
  removeOnFail: { age: 14 * 24 * 3600, count: 2_000 },
});

export async function addAppInstallationJob(data, options = {}) {
  const jobId = options.jobId || joinSafeJobId(
    "app-install",
    data?.shop,
    data?.installationGeneration,
  );

  return appInstallationQueue.add(
    "app-installation",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
