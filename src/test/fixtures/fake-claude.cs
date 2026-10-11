// A real Windows executable for the auth tests, not a renamed script or a real provider login.
// Compiled with Windows' .NET Framework csc in a disposable directory. No network or browser calls.
using System;
using System.IO;
using System.Text;
using System.Threading;

class FakeClaude {
    static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        var state = Environment.GetEnvironmentVariable("FAKE_CLAUDE_STATE");
        if (String.IsNullOrEmpty(state) || args.Length < 2 || args[0] != "auth") return 99;
        if (args[1] == "status") {
            if (!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("FAKE_CLAUDE_ENV_KEY"))) {
                Console.Write("{\"loggedIn\":true,\"authMethod\":\"api_key\",\"apiKeySource\":\"ANTHROPIC_API_KEY\"}");
                return 0;
            }
            var signedIn = File.Exists(state);
            Console.Write(signedIn
                ? "{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"me@example.com\",\"subscriptionType\":\"max\"}"
                : "{\"loggedIn\":false,\"authMethod\":\"none\"}");
            return signedIn ? 0 : 1;
        }
        if (args[1] == "logout") { File.Delete(state); return 0; }
        if (args[1] != "login") return 99;
        var url = "https://claude.test/oauth/authorize?code=true";
        Console.Write("Opening browser to sign in\u2026\r\nIf the browser didn't open, visit: \x1b]8;;" + url + "\x07" + url + "\x1b]8;;\x07\r\nPaste code here if prompted > ");
        if (!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("FAKE_CLAUDE_CALLBACK"))) {
            Thread.Sleep(50);
        } else {
            while (true) {
                var line = Console.ReadLine();
                if (line == null) return 1;
                if (line.Contains("#")) break;
                Console.Error.WriteLine("Invalid code. Please make sure the full code was copied.");
            }
        }
        File.WriteAllText(state, "1");
        Console.WriteLine("Login successful.");
        return 0;
    }
}
