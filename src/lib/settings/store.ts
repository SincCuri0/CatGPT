import fs from "fs/promises";
import path from "path";
import {
  DEFAULT_USER_SETTINGS,
  mergeUserSettings,
  sanitizeUserSettings,
  type UserSettings,
  type UserSettingsPatch,
} from "@/lib/settings/schema";

const USER_SETTINGS_PATH = path.join(process.cwd(), "data", "user-settings.json");

async function ensureSettingsDirectory() {
  await fs.mkdir(path.dirname(USER_SETTINGS_PATH), { recursive: true });
}

async function writeUserSettingsFile(settings: UserSettings) {
  await ensureSettingsDirectory();
  await fs.writeFile(
    USER_SETTINGS_PATH,
    JSON.stringify(settings, null, 2),
    "utf-8",
  );
}

export async function readUserSettings(): Promise<UserSettings> {
  try {
    const raw = await fs.readFile(USER_SETTINGS_PATH, "utf-8");
    return sanitizeUserSettings(JSON.parse(raw));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") {
      await writeUserSettingsFile(DEFAULT_USER_SETTINGS);
      return DEFAULT_USER_SETTINGS;
    }

    console.error("Failed to read user settings; using defaults", error);
    return DEFAULT_USER_SETTINGS;
  }
}

export async function updateUserSettings(patch: UserSettingsPatch): Promise<UserSettings> {
  const current = await readUserSettings();
  const next = mergeUserSettings(current, patch);
  await writeUserSettingsFile(next);
  return next;
}
