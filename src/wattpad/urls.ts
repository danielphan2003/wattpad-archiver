/** True for an `https:` URL on `wattpad.com` or one of its subdomains. */
export const isWattpadHttpsUrl = (url: string) => {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === "https:" && (hostname === "wattpad.com" || hostname.endsWith(".wattpad.com"))
    );
  } catch {
    return false;
  }
};

/** Story and chapter ids are decimal digits. Anything else never reaches a URL or a file name. */
export const isWattpadId = (id: string) => /^\d{1,20}$/.test(id);
