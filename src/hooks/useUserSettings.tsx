"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_USER_SETTINGS,
  mergeUserSettings,
  sanitizeUserSettings,
  type UserSettings,
  type UserSettingsPatch,
} from "@/lib/settings/schema";

interface UseUserSettingsResult {
  settings: UserSettings;
  isLoaded: boolean;
  refreshSettings: () => Promise<void>;
  updateSettings: (patch: UserSettingsPatch) => Promise<UserSettings>;
}

export function useUserSettings(): UseUserSettingsResult {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_USER_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  const refreshSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/user-settings", { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to load user settings (${response.status})`);
      const data = await response.json();
      setSettings(sanitizeUserSettings(data.settings));
    } catch (error) {
      console.error("Failed to load user settings", error);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  const updateSettings = useCallback(async (patch: UserSettingsPatch) => {
    let optimistic = DEFAULT_USER_SETTINGS;
    setSettings((previous) => {
      optimistic = mergeUserSettings(previous, patch);
      return optimistic;
    });

    try {
      const response = await fetch("/api/user-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      });

      if (!response.ok) throw new Error(`Failed to update user settings (${response.status})`);

      const data = await response.json();
      const persisted = sanitizeUserSettings(data.settings);
      setSettings(persisted);
      return persisted;
    } catch (error) {
      console.error("Failed to update user settings", error);
      return optimistic;
    }
  }, []);

  return {
    settings,
    isLoaded,
    refreshSettings,
    updateSettings,
  };
}
