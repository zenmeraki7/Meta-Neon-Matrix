import { useCallback, useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";

import {
  fetchSubscriptionPlans,
  isActivePlan,
  selectActivePlan,
  selectActivePlanError,
  selectActivePlanStatus,
} from "../../../store/slices/subscriptionSlice";

export function usePlanStatus() {
  const dispatch = useDispatch();

  const activePlan = useSelector(selectActivePlan);
  const planError = useSelector(selectActivePlanError);
  const planStatus = useSelector(selectActivePlanStatus);
  const isActive = useSelector(isActivePlan);

  const [alertDismissed, setAlertDismissed] = useState(false);

  const refreshPlan = useCallback(() => {
    dispatch(fetchSubscriptionPlans());
  }, [dispatch]);

  const dismissAlert = useCallback(() => {
    setAlertDismissed(true);
  }, []);

  useEffect(() => {
    if (isActive && alertDismissed) {
      setAlertDismissed(false);
    }
  }, [isActive, alertDismissed]);

  useEffect(() => {
    if (
      activePlan == null &&
      planStatus !== "loading" &&
      planStatus !== "succeeded"
    ) {
      refreshPlan();
    }
  }, [activePlan, planStatus, refreshPlan]);

  const loading = planStatus === "loading";

  let status = "PLAN_REQUIRED";

  if (loading) {
    status = "LOADING";
  } else if (planError || planStatus === "failed") {
    status = "BILLING_ERROR";
  } else if (
    typeof activePlan === "object" &&
    activePlan !== null &&
    (activePlan.active === false || activePlan.status === "INACTIVE")
  ) {
    status = "INACTIVE";
  } else if (
    isActive ||
    (typeof activePlan === "object" && activePlan?.active === true)
  ) {
    status = "ACTIVE";
  } else {
    status = "PLAN_REQUIRED";
  }

  return {
    loading,
    status,
    error: planError,
    showAlert: status !== "ACTIVE" && !alertDismissed,
    dismissAlert,
    refreshPlan,
  };
}
