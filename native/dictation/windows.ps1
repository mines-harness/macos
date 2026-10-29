param([string]$Mode = 'capture', [string]$Locale = 'en-US', [string]$SessionId = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Emit($Value) { [Console]::WriteLine(($Value | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function State($Phase, $Text = '', $Message = $null) {
    Emit @{ sessionId = $SessionId; phase = $Phase; transcript = $Text; error = $Message }
}
$engine = $null
try {
    Add-Type -AssemblyName System.Speech
    $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
        Where-Object { $_.Culture.Name -eq $Locale } | Select-Object -First 1
    if ($Mode -eq 'capability') {
        $reason = $null
        if (!$recognizer) { $reason = 'Install this speech language in Windows Settings to use offline dictation.' }
        Emit @{ available = [bool]$recognizer; locale = $Locale; reason = $reason }
        exit 0
    }
    if (!$recognizer) { throw 'Unsupported speech language' }
    $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($recognizer)
    $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
    $engine.SetInputToDefaultAudioDevice()
    foreach ($name in @('AudioStateChanged', 'SpeechRecognized', 'RecognizeCompleted')) {
        Register-ObjectEvent -InputObject $engine -EventName $name -SourceIdentifier "mines-$name" | Out-Null
    }
    $parts = [System.Collections.Generic.List[string]]::new()
    $inputTask = [Console]::In.ReadLineAsync()
    $phase = 'preparing'
    State $phase
    $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
    $finished = $false
    while (!$finished) {
        $event = Wait-Event -Timeout 1
        if ($event) {
            if ($event.SourceIdentifier -eq 'mines-AudioStateChanged' -and
                $event.SourceEventArgs.AudioState -ne [System.Speech.Recognition.AudioState]::Stopped -and
                $phase -eq 'preparing') {
                $phase = 'recording'
                State $phase
            }
            if ($event.SourceIdentifier -eq 'mines-SpeechRecognized') {
                $parts.Add($event.SourceEventArgs.Result.Text)
            }
            if ($event.SourceIdentifier -eq 'mines-RecognizeCompleted') {
                if ($event.SourceEventArgs.Error) { throw $event.SourceEventArgs.Error }
                State 'finished' ($parts -join ' ')
                $finished = $true
            }
            Remove-Event -EventIdentifier $event.EventIdentifier
        }
        if (!$finished -and $inputTask.IsCompleted) {
            $line = $inputTask.Result
            if ($null -eq $line) { $engine.RecognizeAsyncCancel(); State 'cancelled'; break }
            $command = $line | ConvertFrom-Json
            if ($command.cancel) { $engine.RecognizeAsyncCancel(); State 'cancelled'; break }
            $phase = 'finishing'
            State $phase
            $engine.RecognizeAsyncStop()
            $inputTask = [Console]::In.ReadLineAsync()
        }
    }
} catch {
    $message = 'Windows speech recognition is unavailable. Install a speech language and allow microphone access in Settings.'
    if ($Mode -eq 'capability') { Emit @{ available = $false; locale = $Locale; reason = $message } }
    else { State 'error' '' $message }
} finally {
    foreach ($name in @('AudioStateChanged', 'SpeechRecognized', 'RecognizeCompleted')) {
        Unregister-Event -SourceIdentifier "mines-$name" -ErrorAction SilentlyContinue
    }
    if ($engine) { $engine.Dispose() }
}
