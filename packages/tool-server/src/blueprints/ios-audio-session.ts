import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import { createAudioSession, releaseAudio, type AudioSession } from "../utils/ios-audio";
import { clearAudioLeftovers } from "../utils/ios-audio-leftovers";

// Session for the `audio-*` tools on one iOS simulator: the input feeder this process owns.
// Disposing it (tool-server exit, stop-all-simulator-servers) gives the apps their microphone
// back, so nothing keeps feeding a ring for a device nobody drives any more.
export const IOS_AUDIO_SESSION_NAMESPACE = "IosAudioSession";

export const iosAudioSessionBlueprint: ServiceBlueprint<AudioSession, string> = {
  namespace: IOS_AUDIO_SESSION_NAMESPACE,

  getURN(udid: string) {
    return `${IOS_AUDIO_SESSION_NAMESPACE}:${udid}`;
  },

  async factory(_deps, udid) {
    const session = createAudioSession(udid);
    // A killed tool-server never released its input: clear it before this one writes its own.
    await clearAudioLeftovers(session.dir).catch(() => {});
    return {
      api: session,
      dispose: async () => releaseAudio(session),
      events: new TypedEventEmitter<ServiceEvents>(),
    };
  },
};
