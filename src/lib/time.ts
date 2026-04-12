const TIMEZONE = "Asia/Jakarta";

export const getTimeContext = () => {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("id-ID", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";

  return {
    currentDate: `${get("year")}-${get("month")}-${get("day")}`,
    currentTime: `${get("hour")}:${get("minute")}`,
    currentTimezone: TIMEZONE,
  };
};
