// Rebuilt by scripts/build-windows-dictation.mjs before dev and before a Windows pack.
using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Media.SpeechRecognition;

internal static class WindowsDictation
{
    private const uint WM_QUIT = 0x0012;
    private const uint WM_TIMER = 0x0113;
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

    [DllImport("user32.dll")]
    private static extern IntPtr SetTimer(IntPtr hwnd, IntPtr id, uint milliseconds, IntPtr procedure);

    [DllImport("user32.dll")]
    private static extern bool KillTimer(IntPtr hwnd, IntPtr id);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private static readonly object Gate = new object();
    private static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    private static string committed = "";
    private static bool listening;
    private static SpeechRecognitionEngine engine;
    private static WasapiCapture capture;
    private static string openDeviceId = "";
    private static string openDeviceName = "";
    private static Windows.Media.SpeechRecognition.SpeechRecognizer winrt;
    private static bool winrtActive;
    private static int startDepth;
    private static DateTime lastLevel = DateTime.MinValue;
    private static uint staThreadId;

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
        if (args.Length == 1 && args[0] == "--list-devices")
        {
            EmitDevices();
            return 0;
        }
        try
        {
            Console.SetIn(new StreamReader(Console.OpenStandardInput(), Encoding.UTF8));
        }
        catch (Exception)
        {
            /* stdin already bound */
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
            if (msg.message == WM_TIMER && capture != null) capture.Pull();
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
            if (command == "start") StartDevice("");
            else if (command.StartsWith("start ", StringComparison.Ordinal)) StartDevice(command.Substring(6).Trim());
            else if (command == "devices") EmitDevices();
            else if (command == "stop") Stop();
        }
    }

    private static SpeechRecognitionEngine CreateEngine(Stream pcm)
    {
        var infos = SpeechRecognitionEngine.InstalledRecognizers();
        if (infos == null || infos.Count == 0)
        {
            Emit("{\"type\":\"error\",\"message\":\"Speech recognition is off. Turn it on in Windows Speech settings, then try the mic again.\",\"openSettings\":true,\"settingsUrl\":\"ms-settings:speech\"}");
            return null;
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
        // 16 kHz 16-bit mono is the format this recognizer was built for.
        // Opening the endpoint raw feeds it 32-bit float and it types unrelated words.
        created.SetInputToAudioStream(pcm, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
        created.LoadGrammar(new DictationGrammar());
        created.EndSilenceTimeout = TimeSpan.FromMilliseconds(700);
        created.InitialSilenceTimeout = TimeSpan.FromSeconds(30);
        created.SpeechHypothesized += OnHypothesized;
        created.SpeechRecognized += OnRecognized;
        created.RecognizeCompleted += OnCompleted;
        created.AudioLevelUpdated += OnLevel;
        return created;
    }

    private static void StartDevice(string deviceId)
    {
        deviceId = deviceId ?? "";
        if (listening && (deviceId.Length == 0 || string.Equals(openDeviceId, deviceId, StringComparison.Ordinal)))
        {
            EmitReady();
            return;
        }
        if (listening) Stop();
        if (startDepth > 0) return;
        startDepth++;
        try
        {
            // This PC already has a local recognizer. Do not fall through to
            // online voice typing.
            CloseCapture();
            var rows = WasapiMics.List();
            var chosen = WasapiMics.Choose(rows, deviceId);
            if (chosen == null)
            {
                FailMic("No microphone is connected.");
                return;
            }
            capture = new WasapiCapture();
            if (!capture.Open(chosen))
            {
                var reason = capture.Failure;
                Note(new InvalidOperationException("capture open failed: " + (reason ?? "")));
                CloseCapture();
                FailMic(string.IsNullOrEmpty(reason) ? null : reason);
                return;
            }
            openDeviceId = capture.DeviceId;
            openDeviceName = capture.DeviceName;
            if (EnsureEngine(capture.Pipe))
            {
                listening = true;
                try
                {
                    ArmMicTimer();
                    engine.RecognizeAsync(RecognizeMode.Multiple);
                    if (capture != null) capture.Pull();
                    EmitReady();
                    return;
                }
                catch (Exception ex)
                {
                    Note(ex);
                    listening = false;
                    DisarmMicTimer();
                    try { if (engine != null) engine.Dispose(); } catch (Exception) { }
                    engine = null;
                }
            }
            CloseCapture();
            FailMic(null);
        }
        finally
        {
            startDepth--;
        }
    }

    /// <summary>
    /// Opens the installed offline recognizer. Start does not try online voice typing.
    /// </summary>
    private static bool EnsureEngine(Stream pcm)
    {
        if (engine != null) return true;
        try
        {
            engine = CreateEngine(pcm);
        }
        catch (Exception ex)
        {
            Note(ex);
            engine = null;
        }
        return engine != null;
    }

    private static void Stop()
    {
        var wasListening = listening;
        listening = false;
        DisarmMicTimer();
        if (!wasListening && engine == null && capture == null && !winrtActive) return;
        if (winrtActive)
        {
            winrtActive = false;
            try { winrt.ContinuousRecognitionSession.StopAsync(); } catch (Exception) { }
        }
        // End the capture first. Cancel waits on a blocked stream read, and ending
        // the pipe is what lets that read return.
        CloseCapture();
        try
        {
            if (engine != null) engine.RecognizeAsyncCancel();
        }
        catch (Exception)
        {
            /* not listening */
        }
        try { if (engine != null) engine.Dispose(); } catch (Exception) { }
        engine = null;
    }

    private static IntPtr micTimer;

    private static void ArmMicTimer()
    {
        if (micTimer != IntPtr.Zero) return;
        micTimer = SetTimer(IntPtr.Zero, IntPtr.Zero, 15, IntPtr.Zero);
    }

    private static void DisarmMicTimer()
    {
        if (micTimer == IntPtr.Zero) return;
        KillTimer(IntPtr.Zero, micTimer);
        micTimer = IntPtr.Zero;
    }

    private static void CloseCapture()
    {
        var current = capture;
        capture = null;
        if (current != null) current.Close();
    }

    private static void EmitReady()
    {
        Emit("{\"type\":\"ready\",\"device\":" + Json(openDeviceName ?? "") + ",\"deviceId\":" + Json(openDeviceId ?? "") + "}");
    }

    private static void EmitDevices()
    {
        var rows = WasapiMics.List();
        var chosen = WasapiMics.Choose(rows, "");
        var sb = new StringBuilder();
        sb.Append("{\"type\":\"devices\",\"selected\":").Append(Json(chosen == null ? "" : chosen.Id)).Append(",\"devices\":[");
        for (var i = 0; i < rows.Count; i++)
        {
            if (i > 0) sb.Append(',');
            var row = rows[i];
            sb.Append("{\"id\":").Append(Json(row.Id));
            sb.Append(",\"name\":").Append(Json(row.Name));
            sb.Append(",\"default\":").Append(row.ConsoleDefault ? "true" : "false").Append('}');
        }
        sb.Append("]}");
        Emit(sb.ToString());
    }

    /// <summary>
    /// Windows voice typing uses SpeechRecognizer. That recognizer stays off until
    /// Online speech recognition is accepted, so a privacy refusal returns here
    /// without a transcript. The desktop engine is the path that does not ask for it.
    /// </summary>
    private static bool StartWindowsSpeech()
    {
        try
        {
            winrt = new Windows.Media.SpeechRecognition.SpeechRecognizer();
            winrt.Constraints.Add(new SpeechRecognitionTopicConstraint(SpeechRecognitionScenario.Dictation, "dictation"));
            var compiled = Wait(winrt.CompileConstraintsAsync());
            if (compiled.Status != SpeechRecognitionResultStatus.Success)
                throw new InvalidOperationException("Speech recognition did not start.");
            winrt.HypothesisGenerated += OnWindowsHypothesis;
            winrt.ContinuousRecognitionSession.ResultGenerated += OnWindowsResult;
            Wait(winrt.ContinuousRecognitionSession.StartAsync());
            winrtActive = true;
            listening = true;
            Emit("{\"type\":\"ready\"}");
            return true;
        }
        catch (Exception ex)
        {
            CloseWindowsSpeech();
            if (!SpeechPrivacyBlocked(ex)) return false;
            Emit("{\"type\":\"error\",\"message\":\"Online speech recognition is off. Turn it on in Windows Speech privacy, then try the mic again.\",\"openSettings\":true,\"settingsUrl\":\"ms-settings:privacy-speech\"}");
            return true;
        }
    }

    private static void OnWindowsHypothesis(Windows.Media.SpeechRecognition.SpeechRecognizer sender, SpeechRecognitionHypothesisGeneratedEventArgs e)
    {
        try
        {
            var piece = e.Hypothesis == null ? "" : e.Hypothesis.Text;
            var text = Join(piece);
            if (text.Length == 0) return;
            Emit("{\"type\":\"partial\",\"text\":" + Json(text) + "}");
        }
        catch (Exception ex)
        {
            Note(ex);
        }
    }

    private static void OnWindowsResult(SpeechContinuousRecognitionSession sender, SpeechContinuousRecognitionResultGeneratedEventArgs e)
    {
        try
        {
            if (e.Result == null || e.Result.Status != SpeechRecognitionResultStatus.Success) return;
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

    private static void CloseWindowsSpeech()
    {
        winrtActive = false;
        var current = winrt;
        winrt = null;
        if (current == null) return;
        try { current.Dispose(); } catch (Exception) { }
    }

    private static bool SpeechPrivacyBlocked(Exception ex)
    {
        for (var cursor = ex; cursor != null; cursor = cursor.InnerException)
        {
            var text = cursor.Message ?? "";
            if (text.IndexOf("privacy policy", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (text.IndexOf("speech recognition", StringComparison.OrdinalIgnoreCase) >= 0 &&
                text.IndexOf("not accepted", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        }
        return false;
    }

    /// <summary>
    /// WinRT completes IAsyncOperation on this STA thread. Sleeping here drops the
    /// completion, so the session never reaches ready and the mic looks dead.
    /// </summary>
    private static void PumpUntilSettled(Func<bool> pending)
    {
        var until = DateTime.UtcNow.AddSeconds(8);
        MSG msg;
        while (pending() && DateTime.UtcNow < until)
        {
            if (!PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE))
            {
                Thread.Sleep(10);
                continue;
            }
            if (msg.message == WM_QUIT)
            {
                PostThreadMessage(staThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                return;
            }
            if (msg.message == WM_APP)
            {
                DrainCommands();
                continue;
            }
            if (msg.message == WM_TIMER && capture != null) capture.Pull();
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }

    private static void ThrowIfIncomplete(AsyncStatus status, Exception error)
    {
        if (status == AsyncStatus.Completed) return;
        if (status == AsyncStatus.Started) throw new TimeoutException("Speech recognition did not start.");
        if (error != null) throw error;
        throw new InvalidOperationException("Speech recognition did not start.");
    }

    private static T Wait<T>(IAsyncOperation<T> operation)
    {
        PumpUntilSettled(() => operation.Status == AsyncStatus.Started);
        ThrowIfIncomplete(operation.Status, operation.ErrorCode);
        return operation.GetResults();
    }

    private static void Wait(IAsyncAction operation)
    {
        PumpUntilSettled(() => operation.Status == AsyncStatus.Started);
        ThrowIfIncomplete(operation.Status, operation.ErrorCode);
    }

    private static void OnHypothesized(object sender, SpeechHypothesizedEventArgs e)
    {
        try
        {
            if (!Heard(e.Result)) return;
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
            if (!Heard(e.Result)) return;
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
            FailMic(null);
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

    /// <summary>
    /// Silence and room noise still produce a dictation guess. A very low score is that guess.
    /// </summary>
    private static bool Heard(RecognitionResult result)
    {
        if (result == null || result.Text == null) return false;
        if (result.Confidence < 0.1f) return false;
        return result.Text.Trim().Length > 0;
    }

    private static void FailMic(string reason)
    {
        if (reason == "No microphone is connected.")
        {
            Emit("{\"type\":\"error\",\"message\":\"No microphone is connected.\"}");
            return;
        }
        var message = string.IsNullOrEmpty(reason)
            ? "The microphone did not open. Allow microphone access, then try the mic again."
            : reason;
        Emit("{\"type\":\"error\",\"message\":" + Json(message) + ",\"openSettings\":true,\"settingsUrl\":\"ms-settings:privacy-microphone\"}");
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

internal sealed class MicRow
{
    public string Id;
    public string Name;
    public bool ConsoleDefault;
    public bool CommunicationsDefault;
    public bool Virtual;
}

/// <summary>
/// Captures one endpoint as 16 kHz 16-bit mono PCM. The desktop recognizer
/// misreads a 32-bit float mix, which is the usual format of a USB headset.
/// </summary>
internal sealed class WasapiCapture
{
    public PcmPipe Pipe = new PcmPipe();
    public string DeviceId = "";
    public string DeviceName = "";
    public string Failure = "";
    private volatile bool run;
    private object client;
    private object captureClient;
    private IAudioClient audioClient;
    private IAudioCaptureClient packets;
    private PcmConvert converter;
    private IntPtr mixCopy = IntPtr.Zero;
    private bool held;

    public bool Open(MicRow row)
    {
        DeviceId = row.Id ?? "";
        DeviceName = row.Name ?? "";
        // Open on the calling STA thread. A background thread that activates
        // the endpoint deadlocks against this thread while it is waiting.
        return StartClient();
    }

    public void Close()
    {
        run = false;
        Pipe.End();
        StopClient();
    }

    /// <summary>
    /// Reads whatever the endpoint has queued. Called on the thread that opened
    /// the device, from the message timer, so the recognizer can read the pipe.
    /// </summary>
    public void Pull()
    {
        var source = packets;
        if (source == null || !run) return;
        try
        {
            uint frames;
            if (source.GetNextPacketSize(out frames) < 0) return;
            var pulls = 0;
            while (frames > 0 && pulls < 8)
            {
                pulls++;
                IntPtr data;
                uint read;
                uint flags;
                ulong devicePos;
                ulong qpc;
                if (source.GetBuffer(out data, out read, out flags, out devicePos, out qpc) < 0) return;
                try
                {
                    var silent = (flags & 2) != 0 || data == IntPtr.Zero;
                    if (converter == null)
                    {
                        var count = (int)read * 2;
                        var bytes = new byte[count];
                        if (!silent && count > 0) Marshal.Copy(data, bytes, 0, count);
                        if (count > 0) Pipe.WritePcm(bytes);
                    }
                    else
                    {
                        var pcm = converter.Convert(data, (int)read, silent);
                        if (pcm.Length > 0) Pipe.WritePcm(pcm);
                    }
                }
                finally
                {
                    source.ReleaseBuffer(read);
                }
                if (source.GetNextPacketSize(out frames) < 0) return;
            }
        }
        catch (Exception ex)
        {
            WasapiMics.Note(ex);
        }
    }

    private bool StartClient()
    {
        held = false;
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDevice device;
            var found = enumerator.GetDevice(DeviceId, out device);
            if (found < 0 || device == null)
            {
                WasapiMics.Note(new InvalidOperationException("GetDevice " + found.ToString("X8") + " " + DeviceId));
                Failure = "The microphone did not open. Allow microphone access, then try the mic again.";
                return false;
            }
            var audioClientId = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
            object activated;
            var activatedHr = device.Activate(ref audioClientId, 23, IntPtr.Zero, out activated);
            if (activatedHr < 0 || activated == null)
            {
                WasapiMics.Note(new InvalidOperationException("Activate " + activatedHr.ToString("X8")));
                Failure = "The microphone did not open. Allow microphone access, then try the mic again.";
                return false;
            }
            client = activated;
            audioClient = (IAudioClient)activated;
            var audio = audioClient;
            var direct = TryInitSpeechFormat(audio);
            var convert = false;
            if (!direct)
            {
                IntPtr mix;
                var mixHr = audio.GetMixFormat(out mix);
                if (mixHr < 0 || mix == IntPtr.Zero)
                {
                    WasapiMics.Note(new InvalidOperationException("GetMixFormat " + mixHr.ToString("X8")));
                    Failure = "The microphone did not open. Allow microphone access, then try the mic again.";
                    return false;
                }
                var extra = Marshal.ReadInt16(mix, 16);
                if (extra < 0 || extra > 256) extra = 0;
                var size = 18 + extra;
                mixCopy = Marshal.AllocHGlobal(size);
                var mixBytes = new byte[size];
                Marshal.Copy(mix, mixBytes, 0, size);
                Marshal.Copy(mixBytes, 0, mixCopy, size);
                Marshal.FreeCoTaskMem(mix);
                // A failed Initialize can leave the client stuck. Open a fresh one for the mix format.
                WasapiMics.Release(activated);
                client = null;
                audioClient = null;
                activatedHr = device.Activate(ref audioClientId, 23, IntPtr.Zero, out activated);
                if (activatedHr < 0 || activated == null)
                {
                    WasapiMics.Note(new InvalidOperationException("Activate mix " + activatedHr.ToString("X8")));
                    Failure = "The microphone did not open. Allow microphone access, then try the mic again.";
                    return false;
                }
                client = activated;
                audioClient = (IAudioClient)activated;
                audio = audioClient;
                var mixInit = audio.Initialize(0, 0, 10000000, 0, mixCopy, IntPtr.Zero);
                if (mixInit < 0)
                {
                    WasapiMics.Note(new InvalidOperationException("Initialize mix " + mixInit.ToString("X8")));
                    Failure = "The microphone did not open. Allow microphone access, then try the mic again.";
                    return false;
                }
                convert = true;
            }
            var serviceId = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
            object service;
            var serviceHr = audio.GetService(ref serviceId, out service);
            if (serviceHr < 0 || service == null)
            {
                Failure = "The microphone did not open. Allow microphone access, then try the mic again.";
                return false;
            }
            captureClient = service;
            packets = (IAudioCaptureClient)service;
            if (audio.Start() < 0)
            {
                WasapiMics.Note(new InvalidOperationException("Start"));
                Failure = "The microphone did not open. Allow microphone access, then try the mic again.";
                return false;
            }
            converter = convert ? PcmConvert.FromMix(mixCopy) : null;
            if (mixCopy != IntPtr.Zero) Marshal.FreeHGlobal(mixCopy);
            mixCopy = IntPtr.Zero;
            held = true;
            run = true;
            return true;
        }
        catch (Exception ex)
        {
            WasapiMics.Note(ex);
            if (Failure.Length == 0) Failure = "The microphone did not open. Allow microphone access, then try the mic again.";
            return false;
        }
        finally
        {
            if (mixCopy != IntPtr.Zero) Marshal.FreeHGlobal(mixCopy);
            mixCopy = IntPtr.Zero;
            if (!held) StopClient();
        }
    }

    private void StopClient()
    {
        try { if (audioClient != null) audioClient.Stop(); } catch (Exception) { }
        WasapiMics.Release(captureClient);
        WasapiMics.Release(client);
        captureClient = null;
        client = null;
        audioClient = null;
        packets = null;
    }

    private static bool TryInitSpeechFormat(IAudioClient audio)
    {
        var format = new WaveFormatPcm16();
        format.FormatTag = 1;
        format.Channels = 1;
        format.SamplesPerSecond = 16000;
        format.AverageBytesPerSecond = 32000;
        format.BlockAlign = 2;
        format.BitsPerSample = 16;
        var ptr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WaveFormatPcm16)));
        try
        {
            Marshal.StructureToPtr(format, ptr, false);
            const uint autoConvert = 0x80000000;
            const uint defaultQuality = 0x08000000;
            var hr = audio.Initialize(0, autoConvert | defaultQuality, 10000000, 0, ptr, IntPtr.Zero);
            if (hr < 0) WasapiMics.Note(new InvalidOperationException("Initialize speech format " + hr.ToString("X8")));
            return hr >= 0;
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
    }
}

internal static class WasapiMics
{
    public static void Note(Exception ex)
    {
        try
        {
            File.AppendAllText(Path.Combine(Path.GetTempPath(), "workhorse-dictation-crash.txt"), ex + "\r\n");
        }
        catch (Exception)
        {
            /* keep the capture alive */
        }
    }

    public static void Release(object com)
    {
        try
        {
            if (com != null && Marshal.IsComObject(com)) Marshal.ReleaseComObject(com);
        }
        catch (Exception)
        {
            /* already released */
        }
    }

    public static bool IsVirtual(string name)
    {
        var text = (name ?? "").ToLowerInvariant();
        string[] markers =
        {
            "virtual mixer",
            "sonic studio",
            "steam streaming",
            "stereo mix",
            "what u hear",
            "cable output",
            "vb-audio",
            "voicemeeter",
        };
        foreach (var marker in markers)
        {
            if (text.IndexOf(marker, StringComparison.Ordinal) >= 0) return true;
        }
        return false;
    }

    public static MicRow Choose(System.Collections.Generic.List<MicRow> rows, string requestedId)
    {
        if (rows == null || rows.Count == 0) return null;
        if (!string.IsNullOrEmpty(requestedId))
        {
            foreach (var row in rows)
            {
                if (string.Equals(row.Id, requestedId, StringComparison.Ordinal)) return row;
            }
        }
        MicRow console = null;
        MicRow communications = null;
        MicRow real = null;
        foreach (var row in rows)
        {
            if (row.ConsoleDefault && console == null) console = row;
            if (row.CommunicationsDefault && communications == null) communications = row;
            if (!row.Virtual && real == null) real = row;
        }
        if (console != null && !console.Virtual) return console;
        if (communications != null && !communications.Virtual) return communications;
        if (real != null) return real;
        if (console != null) return console;
        return rows[0];
    }

    public static System.Collections.Generic.List<MicRow> List()
    {
        var rows = new System.Collections.Generic.List<MicRow>();
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDeviceCollection collection;
            if (enumerator.EnumAudioEndpoints(1, 1, out collection) < 0 || collection == null) return rows;
            var consoleId = DefaultId(enumerator, 0);
            var communicationsId = DefaultId(enumerator, 2);
            int count;
            if (collection.GetCount(out count) < 0 || count < 0) return rows;
            if (count > 32) count = 32;
            for (var i = 0; i < count; i++)
            {
                IMMDevice device;
                if (collection.Item(i, out device) < 0 || device == null) continue;
                string id;
                if (device.GetId(out id) < 0 || string.IsNullOrEmpty(id)) continue;
                var name = ReadName(device);
                if (string.IsNullOrEmpty(name)) name = "Microphone";
                rows.Add(new MicRow
                {
                    Id = id,
                    Name = name,
                    ConsoleDefault = string.Equals(id, consoleId, StringComparison.Ordinal),
                    CommunicationsDefault = string.Equals(id, communicationsId, StringComparison.Ordinal),
                    Virtual = IsVirtual(name),
                });
            }
        }
        catch (Exception)
        {
            return rows;
        }
        return rows;
    }

    private static string DefaultId(IMMDeviceEnumerator enumerator, int role)
    {
        try
        {
            IMMDevice device;
            if (enumerator.GetDefaultAudioEndpoint(1, role, out device) < 0 || device == null) return "";
            string id;
            if (device.GetId(out id) < 0 || id == null) return "";
            return id;
        }
        catch (Exception)
        {
            return "";
        }
    }

    private static string ReadName(IMMDevice device)
    {
        try
        {
            IPropertyStore store;
            if (device.OpenPropertyStore(0, out store) < 0 || store == null) return "";
            var key = new PropertyKey
            {
                fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
                pid = 14,
            };
            PropVariant value;
            if (store.GetValue(ref key, out value) < 0) return "";
            try
            {
                if (value.vt == 31 && value.pointer != IntPtr.Zero) return Marshal.PtrToStringUni(value.pointer) ?? "";
                return "";
            }
            finally
            {
                PropVariantClear(ref value);
            }
        }
        catch (Exception)
        {
            return "";
        }
    }

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);
}

internal sealed class PcmPipe : Stream
{
    private readonly object gate = new object();
    private readonly System.Collections.Generic.Queue<byte[]> chunks = new System.Collections.Generic.Queue<byte[]>();
    private byte[] current;
    private int offset;
    private int buffered;
    private bool closed;

    public void WritePcm(byte[] data)
    {
        if (data == null || data.Length == 0) return;
        lock (gate)
        {
            if (closed) return;
            chunks.Enqueue(data);
            buffered += data.Length;
            while (buffered > 64000 && chunks.Count > 1)
            {
                var drop = chunks.Dequeue();
                buffered -= drop.Length;
            }
            Monitor.PulseAll(gate);
        }
    }

    public void End()
    {
        lock (gate)
        {
            closed = true;
            Monitor.PulseAll(gate);
        }
    }

    public override int Read(byte[] buffer, int start, int count)
    {
        lock (gate)
        {
            while (!closed && current == null && chunks.Count == 0) Monitor.Wait(gate);
            if (current == null)
            {
                if (chunks.Count == 0) return 0;
                current = chunks.Dequeue();
                offset = 0;
            }
            var n = Math.Min(count, current.Length - offset);
            Buffer.BlockCopy(current, offset, buffer, start, n);
            offset += n;
            buffered -= n;
            if (offset >= current.Length) current = null;
            return n;
        }
    }

    public override bool CanRead { get { return true; } }
    // SAPI asks for Length while attaching the stream. A live mic has no end,
    // and throwing here makes the recognizer refuse the microphone.
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return long.MaxValue; } }
    public override long Position
    {
        get { return 0; }
        set { }
    }
    public override void Flush() { }
    public override long Seek(long pos, SeekOrigin origin) { return 0; }
    public override void SetLength(long value) { }
    public override void Write(byte[] buffer, int start, int count) { }
}

internal sealed class PcmConvert
{
    private readonly int channels;
    private readonly int rate;
    private readonly int bits;
    private readonly bool floating;
    private double cursor;
    private float previous;
    private bool hasPrevious;

    private PcmConvert(int channels, int rate, int bits, bool floating)
    {
        this.channels = channels < 1 ? 1 : channels;
        this.rate = rate < 1 ? 16000 : rate;
        this.bits = bits;
        this.floating = floating;
    }

    public static PcmConvert FromMix(IntPtr format)
    {
        var tag = (ushort)Marshal.ReadInt16(format, 0);
        var channels = Marshal.ReadInt16(format, 2);
        var rate = Marshal.ReadInt32(format, 4);
        var bits = Marshal.ReadInt16(format, 14);
        var floating = tag == 3;
        if (tag == 0xFFFE && format != IntPtr.Zero)
        {
            var sub = Marshal.ReadInt32(format, 24);
            floating = sub == 3;
        }
        return new PcmConvert(channels, rate, bits, floating);
    }

    public byte[] Convert(IntPtr data, int frames, bool silent)
    {
        if (frames <= 0) return new byte[0];
        var mono = new float[frames];
        var block = floating || bits >= 32 ? 4 : (bits <= 8 ? 1 : 2);
        for (var frame = 0; frame < frames; frame++)
        {
            if (silent || data == IntPtr.Zero)
            {
                mono[frame] = 0;
                continue;
            }
            float sum = 0;
            for (var channel = 0; channel < channels; channel++)
            {
                var index = (frame * channels + channel) * block;
                if (floating)
                {
                    var sample = new byte[4];
                    Marshal.Copy(IntPtr.Add(data, index), sample, 0, 4);
                    sum += BitConverter.ToSingle(sample, 0);
                }
                else if (bits <= 8)
                {
                    sum += (Marshal.ReadByte(data, index) - 128) / 128f;
                }
                else if (bits >= 32)
                {
                    sum += Marshal.ReadInt32(data, index) / 2147483648f;
                }
                else
                {
                    sum += Marshal.ReadInt16(data, index) / 32768f;
                }
            }
            mono[frame] = sum / channels;
        }
        var step = rate / 16000.0;
        if (step <= 0) step = 1;
        var output = new System.Collections.Generic.List<byte>(frames);
        while (cursor < frames)
        {
            var i0 = (int)cursor;
            var frac = (float)(cursor - i0);
            var a = i0 <= 0 ? (hasPrevious ? previous : mono[0]) : mono[Math.Min(i0, frames - 1)];
            var b = Math.Min(i0 + 1, frames - 1);
            var sample = a + (mono[b] - a) * frac;
            if (sample > 1) sample = 1;
            if (sample < -1) sample = -1;
            var pcm = (short)Math.Round(sample * 32767f);
            output.Add((byte)(pcm & 0xff));
            output.Add((byte)((pcm >> 8) & 0xff));
            cursor += step;
        }
        cursor -= frames;
        previous = mono[frames - 1];
        hasPrevious = true;
        return output.ToArray();
    }
}

[StructLayout(LayoutKind.Sequential, Pack = 2)]
internal struct WaveFormatPcm16
{
    public ushort FormatTag;
    public ushort Channels;
    public uint SamplesPerSecond;
    public uint AverageBytesPerSecond;
    public ushort BlockAlign;
    public ushort BitsPerSample;
    public ushort Extra;
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class MMDeviceEnumeratorComObject
{
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceCollection
{
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice
{
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPropertyStore
{
    int GetCount(out uint count);
    int GetAt(uint index, out PropertyKey key);
    int GetValue(ref PropertyKey key, out PropVariant value);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioClient
{
    int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    int GetBufferSize(out uint frames);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out uint frames);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr handle);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioCaptureClient
{
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    int ReleaseBuffer(uint frames);
    int GetNextPacketSize(out uint frames);
}

[StructLayout(LayoutKind.Sequential)]
internal struct PropertyKey
{
    public Guid fmtid;
    public uint pid;
}

[StructLayout(LayoutKind.Explicit, Size = 24)]
internal struct PropVariant
{
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointer;
}
