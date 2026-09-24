export async function readCredentials() {
  const credentials = {
    email: process.env.SCHULCLOUD_EMAIL,
    password: process.env.SCHULCLOUD_PASSWORD,
    securityPassword: process.env.SCHULCLOUD_SECURITY_PASSWORD,
  };
  if (Object.values(credentials).every(Boolean)) return credentials;
  if (!process.stdin.isTTY) {
    throw new Error(
      "Für die Anmeldung ist ein Terminal nötig. Zugangsdaten können alternativ als Prozess-Umgebungsvariablen übergeben werden.",
    );
  }
  credentials.email ||= await hiddenQuestion("schul.cloud E-Mail: ");
  credentials.password ||= await hiddenQuestion("Account-Kennwort: ");
  credentials.securityPassword ||= await hiddenQuestion(
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
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (buffer) => {
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
