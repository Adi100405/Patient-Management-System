import type { NotificationChannel, NotificationMessage } from "../types";

/**
 * Log transport. The selected channel whenever no email provider is configured,
 * so the whole notification pipeline stays exercisable (and demoable) without
 * any third-party account: the email that *would* have been sent is printed to
 * the server log in full.
 */
export const logChannel: NotificationChannel = {
  name: "log",
  async send(message: NotificationMessage) {
    console.info("[notification]", JSON.stringify(message));
  },
};
