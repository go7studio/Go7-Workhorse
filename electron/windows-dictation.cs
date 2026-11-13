// Rebuilt by scripts/build-windows-dictation.mjs before dev and before a Windows pack.
using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Text;
using System.Threading;

internal static class WindowsDictation
{
    private const uint WM_QUIT = 0x0012;
    private const uint WM_APP = 0x8000;
    private const uint PM_NOREMOVE = 0;
    private const uint PM_REMOVE = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max, uint remove);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage([In] ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage([In] ref MSG lpMsg);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private static readonly object Gate = new object();
    private static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    private static string committed = "";
    private static bool listening;
    private static SpeechRecognitionEngine engine;
    private static DateTime lastLevel = DateTime.MinValue;
    private static uint staThreadId;

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
        try
        {
            Console.SetIn(new StreamReader(Console.OpenStandardInput(), Encoding.UTF8));
        }
        catch (Exception)
        {
            /* stdin already bound */
        }

        try
        {
            engine = CreateEngine();
        }
        catch (Exception)
        {
            FailMic();
            return 3;
        }

        staThreadId = GetCurrentThreadId();
        // PostThreadMessage fails until this thread has a queue. PeekMessage creates it
        // before the stdin thread can deliver the first "start".
        MSG warmup;
        PeekMessage(out warmup, IntPtr.Zero, 0, 0, PM_NOREMOVE);
        var stdin = new Thread(ReadCommands);
        stdin.IsBackground = true;
        stdin.Start();

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            if (msg.message == WM_APP)
            {
                DrainCommands();
                continue;
            }
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }

        try
        {
            if (engine != null) engine.Dispose();
        }
        catch (Exception)
        {
            /* already closed */
        }
        return 0;
    }

    private static void ReadCommands()
    {
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                Commands.Enqueue(line.Trim());
                Wake(WM_APP);
            }
        }
        catch (Exception)
        {
            /* stdin closed */
        }
        Wake(WM_QUIT);
    }

    private static void Wake(uint message)
    {
        for (var attempt = 0; attempt < 40; attempt++)
        {
            if (PostThreadMessage(staThreadId, message, IntPtr.Zero, IntPtr.Zero)) return;
            Thread.Sleep(5);
        }
    }

    private static void DrainCommands()
    {
        string command;
        while (Commands.TryDequeue(out command))
        {
            if (command == "start") Start();
            else if (command == "stop") Stop();
        }
    }

    private static SpeechRecognitionEngine CreateEngine()
    {
        var infos = SpeechRecognitionEngine.InstalledRecognizers();
        if (infos == null || infos.Count == 0)
        {
            Emit("{\"type\":\"error\",\"message\":\"Speech recognition is off. Turn it on in Windows Speech settings, then try the mic again.\",\"openSettings\":true,\"settingsUrl\":\"ms-settings:speech\"}");
            Environment.Exit(2);
        }

        var culture = CultureInfo.CurrentUICulture.Name;
        RecognizerInfo chosen = null;
        foreach (RecognizerInfo info in infos)
        {
            if (info.Culture.Name == culture)
            {
                chosen = info;
                break;
            }
        }
        if (chosen == null)
        {
            foreach (RecognizerInfo info in infos)
            {
                if (info.Culture.Name == "en-US")
                {
                    chosen = info;
                    break;
                }
            }
        }
        if (chosen == null) chosen = infos[0];

        var created = new SpeechRecognitionEngine(chosen.Culture);
        created.SetInputToDefaultAudioDevice();
        created.LoadGrammar(new DictationGrammar());
        created.EndSilenceTimeout = TimeSpan.FromMilliseconds(700);
        created.InitialSilenceTimeout = TimeSpan.FromSeconds(30);
        created.SpeechHypothesized += OnHypothesized;
        created.SpeechRecognized += OnRecognized;
        created.RecognizeCompleted += OnCompleted;
        created.AudioLevelUpdated += OnLevel;
        return created;
    }

    private static void Start()
    {
        if (listening)
        {
            Emit("{\"type\":\"ready\"}");
            return;
        }
        listening = true;
        try
        {
            engine.RecognizeAsync(RecognizeMode.Multiple);
            Emit("{\"type\":\"ready\"}");
        }
        catch (Exception)
        {
            listening = false;
            FailMic();
        }
    }

    private static void Stop()
    {
        if (!listening) return;
        listening = false;
        try
        {
            engine.RecognizeAsyncCancel();
        }
        catch (Exception)
        {
            /* not listening */
        }
    }

    private static void OnHypothesized(object sender, SpeechHypothesizedEventArgs e)
    {
        try
        {
            if (e.Result == null) return;
            var text = Join(e.Result.Text);
            if (text.Length == 0) return;
            Emit("{\"type\":\"partial\",\"text\":" + Json(text) + "}");
        }
        catch (Exception ex)
        {
            Note(ex);
        }
    }

    private static void OnRecognized(object sender, SpeechRecognizedEventArgs e)
    {
        try
        {
            if (e.Result == null) return;
            var text = Join(e.Result.Text);
            if (text.Length == 0) return;
            lock (Gate) committed = text;
            Emit("{\"type\":\"final\",\"text\":" + Json(text) + "}");
        }
        catch (Exception ex)
        {
            Note(ex);
        }
    }

    private static void OnCompleted(object sender, RecognizeCompletedEventArgs e)
    {
        if (!listening || e.Cancelled) return;
        if (e.Error != null)
        {
            listening = false;
            FailMic();
            return;
        }
        try
        {
            engine.RecognizeAsync(RecognizeMode.Multiple);
        }
        catch (Exception)
        {
            /* this phrase ended while the session is still listening */
        }
    }

    private static void OnLevel(object sender, AudioLevelUpdatedEventArgs e)
    {
        try
        {
            var now = DateTime.UtcNow;
            lock (Gate)
            {
                if ((now - lastLevel).TotalMilliseconds < 100) return;
                lastLevel = now;
            }
            // The desktop meter stays near 0 until the room is loud. A short
            // curve makes a real voice move the bars without lifting silence.
            var raw = e.AudioLevel < 0 ? 0 : (e.AudioLevel > 100 ? 100 : e.AudioLevel);
            var level = raw == 0 ? 0 : Math.Pow(raw / 100.0, 0.35);
            level = Math.Round(Math.Min(1.0, level), 3);
            Emit("{\"type\":\"level\",\"value\":" + level.ToString(CultureInfo.InvariantCulture) + "}");
        }
        catch (Exception ex)
        {
            Note(ex);
        }
    }

    private static void Note(Exception ex)
    {
        try
        {
            File.AppendAllText(Path.Combine(Path.GetTempPath(), "workhorse-dictation-crash.txt"), ex.ToString() + "\r\n");
        }
        catch (Exception)
        {
            /* keep the recognizer alive */
        }
    }

    private static string Join(string piece)
    {
        piece = (piece ?? "").Trim();
        string current;
        lock (Gate) current = committed;
        if (piece.Length == 0) return current;
        if (current.Length == 0) return piece;
        if (current.EndsWith(" ", StringComparison.Ordinal) || current.EndsWith("\n", StringComparison.Ordinal))
            return current + piece;
        return current + " " + piece;
    }

    private static void FailMic()
    {
        Emit("{\"type\":\"error\",\"message\":\"The microphone did not open. Allow microphone access, then try the mic again.\",\"openSettings\":true,\"settingsUrl\":\"ms-settings:privacy-microphone\"}");
    }

    private static int SelfTest()
    {
        var wav = Path.Combine(Path.GetTempPath(), "workhorse-dictation-self-test.wav");
        try
        {
            using (var synth = new SpeechSynthesizer())
            {
                synth.SetOutputToWaveFile(wav);
                synth.Speak("hello desk");
            }
            var text = RecognizeWav(wav);
            Emit("{\"type\":\"final\",\"text\":" + Json(text) + "}");
            return text.Length == 0 ? 4 : 0;
        }
        catch (Exception ex)
        {
            Emit("{\"type\":\"error\",\"message\":" + Json(ex.Message) + "}");
            return 5;
        }
        finally
        {
            try { if (File.Exists(wav)) File.Delete(wav); } catch (Exception) { }
        }
    }

    private static string RecognizeWav(string wav)
    {
        var text = "";
        var done = new ManualResetEvent(false);
        using (var recognizer = new SpeechRecognitionEngine(new CultureInfo("en-US")))
        {
            recognizer.SetInputToWaveFile(wav);
            recognizer.LoadGrammar(new DictationGrammar());
            recognizer.SpeechRecognized += delegate(object sender, SpeechRecognizedEventArgs e)
            {
                try
                {
                    if (e.Result != null && e.Result.Text != null) text = e.Result.Text.Trim();
                }
                catch (Exception)
                {
                    /* wait for completed */
                }
            };
            recognizer.RecognizeCompleted += delegate { done.Set(); };
            recognizer.RecognizeAsync(RecognizeMode.Single);
            PumpUntil(done, 8);
            try { recognizer.RecognizeAsyncCancel(); } catch (Exception) { }
        }
        if (text.Length > 0) return text;
        using (var recognizer = new SpeechRecognitionEngine(new CultureInfo("en-US")))
        {
            recognizer.SetInputToWaveFile(wav);
            recognizer.LoadGrammar(new DictationGrammar());
            var result = recognizer.Recognize(TimeSpan.FromSeconds(8));
            return result == null ? "" : (result.Text ?? "").Trim();
        }
    }

    private static void PumpUntil(WaitHandle done, int seconds)
    {
        var until = DateTime.UtcNow.AddSeconds(seconds);
        MSG msg;
        while (DateTime.UtcNow < until)
        {
            if (done.WaitOne(0)) return;
            if (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE))
            {
                if (msg.message == WM_QUIT) return;
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            else
            {
                Thread.Sleep(15);
            }
        }
    }

    private static void Emit(string json)
    {
        var bytes = new UTF8Encoding(false).GetBytes(json + "\n");
        lock (Gate)
        {
            var stdout = Console.OpenStandardOutput();
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }
    }

    private static string Json(string value)
    {
        var sb = new StringBuilder();
        sb.Append('"');
        foreach (var ch in value)
        {
            if (ch == '\\' || ch == '"') sb.Append('\\').Append(ch);
            else if (ch == '\n') sb.Append("\\n");
            else if (ch == '\r') sb.Append("\\r");
            else if (ch < 32) sb.Append("\\u").Append(((int)ch).ToString("x4"));
            else sb.Append(ch);
        }
        sb.Append('"');
        return sb.ToString();
    }
}
