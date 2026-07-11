type ClipboardEnvironment = {
  windowValue: any;
  documentValue: Document;
  navigatorValue: Navigator;
};

const copyWithDocument = (text: string, documentValue: Document): boolean => {
  if (typeof documentValue.execCommand !== "function") return false;
  const input = documentValue.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  documentValue.body.appendChild(input);
  try {
    input.focus();
    input.select();
    return documentValue.execCommand("copy") === true;
  } finally {
    documentValue.body.removeChild(input);
  }
};

const copyWithSteamClient = async (text: string, windowValue: any): Promise<boolean> => {
  const steamClient = windowValue?.SteamClient;
  if (!steamClient) return false;
  const candidates: Array<[any, unknown]> = [
    [steamClient.System, steamClient.System?.SetClipboardText],
    [steamClient.System, steamClient.System?.CopyToClipboard],
    [steamClient.System, steamClient.System?.SetClipboard],
    [steamClient.Utils, steamClient.Utils?.SetClipboardText],
    [steamClient.Utils, steamClient.Utils?.CopyToClipboard],
    [steamClient.Browser, steamClient.Browser?.SetClipboardText],
  ];

  for (const [owner, candidate] of candidates) {
    if (typeof candidate !== "function") continue;
    try {
      const result = candidate.call(owner, text);
      const resolved = result && typeof result.then === "function" ? await result : result;
      if (resolved !== false) return true;
    } catch {
      // Continue to the next supported Steam clipboard method.
    }
  }
  return false;
};

export const copyTextToClipboard = async (
  text: string,
  environment: ClipboardEnvironment = {
    windowValue: window,
    documentValue: document,
    navigatorValue: navigator,
  },
): Promise<boolean> => {
  if (!text) return false;
  try {
    if (copyWithDocument(text, environment.documentValue)) return true;
  } catch {
    // SteamClient and the standard Clipboard API remain available as fallbacks.
  }
  if (await copyWithSteamClient(text, environment.windowValue)) return true;
  try {
    const clipboard = environment.navigatorValue?.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};
