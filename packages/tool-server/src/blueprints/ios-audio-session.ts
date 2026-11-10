import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import { createAudioSession, releaseAudio, type AudioSession } from "../utils/ios-audio";

// Session for the `audio-*` tools on one iOS simulator: the input feeder and the recorders this
// process owns. Disposing it (tool-server exit, stop-all-simulator-servers) gives the apps their
// microphone back and drops the recordings, so nothing keeps feeding or draining a ring for a
// device nobody drives any more.
export const IOS_AUDIO_SESSION_NAMESPACE = "IosAudioSession";

export const iosAudioSessionBlueprint: ServiceBlueprint<AudioSession, string> = {
  namespace: IOS_AUDIO_SESSION_NAMESPACE,

  getURN(udid: string) {
    return `${IOS_AUDIO_SESSION_NAMESPACE}:${udid}`;
  },

  async factory(_deps, udid) {
    const session = createAudioSession(udid);
    return {
      api: session,
      dispose: async () => releaseAudio(session),
      events: new TypedEventEmitter<ServiceEvents>(),
    };
  },
};
