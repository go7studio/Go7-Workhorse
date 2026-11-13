// Rebuilt by scripts/build-windows-dictation.mjs before dev and before a Windows pack.
using System;
using System.Globalization;
using System.IO;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Text;
using System.Threading;

internal static class WindowsDictation
{
    private static readonly object Gate = new object();
    private static string committed = "";
    private static bool listening;
    private static SpeechRecognitionEngine engine;
    private static DateTime lastLevel = DateTime.MinValue;

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
        try
        {
            engine = CreateEngine();
        }
        catch (Exception)
        {
            FailMic();
            return 3;
        }

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            var command = line.Trim();
            if (command == "start") Start();
            else if (command == "stop") Stop();
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
            using (var recognizer = new SpeechRecognitionEngine(new CultureInfo("en-US")))
            {
                recognizer.SetInputToWaveFile(wav);
                recognizer.LoadGrammar(new DictationGrammar());
                var result = recognizer.Recognize(TimeSpan.FromSeconds(8));
                var text = result == null ? "" : (result.Text ?? "").Trim();
                Emit("{\"type\":\"final\",\"text\":" + Json(text) + "}");
                return text.Length == 0 ? 4 : 0;
            }
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
