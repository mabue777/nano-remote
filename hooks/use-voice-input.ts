import { type ExpoSpeechRecognitionErrorEvent, ExpoSpeechRecognitionModule, type ExpoSpeechRecognitionResultEvent, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useRef, useState } from 'react';
import { Animated } from 'react-native';

import { useSettings } from './use-settings';

interface UseVoiceInputOptions {
  audioWavesShape?: number[];
  onStart?: () => void;
  onEnd?: () => void;
  onResult?: (event: ExpoSpeechRecognitionResultEvent) => void;
  onError?: (event: ExpoSpeechRecognitionErrorEvent) => void;
  onVolumeChange?: (event: { value: number }) => void;
}

const DEFAULT_AUDIO_WAVES_SHAPE = [0, 0.2, 0.4, 0.6, 0.8, 1, 0.8, 0.6, 0.4, 0.2, 0];

export function useVoiceInput(options?: UseVoiceInputOptions) {
  const { audioWavesShape = DEFAULT_AUDIO_WAVES_SHAPE, onStart, onEnd, onResult, onError, onVolumeChange } = options ?? {};
  const [{ voiceLanguage = 'en-US' }] = useSettings();
  const [recognizing, setRecognizing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const audioWaves = useRef(audioWavesShape.map(() => new Animated.Value(4))).current;

  useSpeechRecognitionEvent('start', () => {
    setRecognizing(true);
    onStart?.();
  });

  useSpeechRecognitionEvent('end', () => {
    setRecognizing(false);
    audioWaves.forEach(anim => anim.setValue(4));
    onEnd?.();
  });

  useSpeechRecognitionEvent('result', event => {
    setTranscript(event.results[0]?.transcript || '');
    onResult?.(event);
  });

  useSpeechRecognitionEvent('error', event => {
    onError?.(event);
  });

  useSpeechRecognitionEvent('volumechange', event => {
    const normalized = event.value > 3 ? event.value / 10 : 0;
    audioWavesShape.forEach((multiplier, i) => {
      Animated.spring(audioWaves[i], {
        toValue: 4 + normalized * 30 * multiplier,
        speed: 20,
        bounciness: 4,
        useNativeDriver: false
      }).start();
    });

    onVolumeChange?.(event);
  });

  const start = async () => {
    const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!result.granted) return;

    if (recognizing) return;

    setTranscript('');
    ExpoSpeechRecognitionModule.start({
      lang: voiceLanguage,
      interimResults: true,
      continuous: true,
      volumeChangeEventOptions: {
        enabled: true,
        intervalMillis: 300
      }
    });
  };

  const stop = () => {
    setTranscript('');
    ExpoSpeechRecognitionModule.stop();
  };

  return { transcript, recognizing, audioWaves, start, stop };
}
