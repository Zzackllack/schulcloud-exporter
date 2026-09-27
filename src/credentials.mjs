/**
 * Credentials already present in the environment, or null when incomplete.
 *
 * The server has no terminal to prompt on, so it needs this instead of
 * readCredentials(): calling that from a long-lived process would either throw
 * or block on a TTY that nobody is watching.
 */
export function credentialsFromEnv() {
  const credentials = {
    email: process.env.SCHULCLOUD_EMAIL,
    password: process.env.SCHULCLOUD_PASSWORD,
    securityPassword: process.env.SCHULCLOUD_SECURITY_PASSWORD,
  };
  return Object.values(credentials).every(Boolean) ? credentials : null;
}

export async function readCredentials() {
  const fromEnv = credentialsFromEnv();
  if (fromEnv) return fromEnv;
  const credentials = { email: null, password: null, securityPassword: null };
  if (!process.stdin.isTTY) {
    throw new Error(
      "Für die Anmeldung ist ein Terminal nötig. Zugangsdaten können alternativ als Prozess-Umgebungsvariablen übergeben werden.",
    );
  }
  credentials.email = await hiddenQuestion("schul.cloud E-Mail: ");
  credentials.password = await hiddenQuestion("Account-Kennwort: ");
  credentials.securityPassword = await hiddenQuestion(
    "Verschlüsselungskennwort: ",
  );
  if (Object.values(credentials).some((value) => !value)) {
    throw new Error("Alle drei Anmeldedaten werden benötigt.");
  }
  return credentials;
}

function hiddenQuestion(prompt) {
  return new Promise((resolve, reject) => {
    let value = "";
    const input = process.stdin;
    let rawModeEnabled = false;
    let onData = null;
    const cleanup = () => {
      if (onData) input.off("data", onData);
      if (rawModeEnabled) {
        input.setRawMode(false);
        rawModeEnabled = false;
      }
      input.pause();
      process.stdout.write("\n");
    };
    process.stdout.write(prompt);
    try {
      input.setRawMode(true);
      rawModeEnabled = true;
      input.resume();
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    const finish = (error) => {
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    onData = (buffer) => {
      for (const character of buffer.toString("utf8")) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003")
          return finish(new Error("Eingabe abgebrochen"));
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    input.on("data", onData);
  });
}
