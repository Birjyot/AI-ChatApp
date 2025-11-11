import { GoogleGenerativeAI, type ChatSession } from "@google/generative-ai";
import type { Channel, MessageResponse, StreamChat } from "stream-chat";

export class GeminiResponseHandler {
  private message_text = "";
  private is_done = false;
  private last_update_time = 0;

  constructor(
    private readonly chatSession: ChatSession,
    private readonly model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
    private readonly chatClient: StreamChat,
    private readonly channel: Channel,
    private readonly message: MessageResponse,
    private readonly systemPrompt: string,
    private readonly userMessage: string,
    private readonly onDispose: () => void
  ) {
    this.chatClient.on("ai_indicator.stop", this.handleStopGenerating);
  }

  run = async () => {
    const { cid, id: message_id } = this.message;

    try {
      await this.channel.sendEvent({
        type: "ai_indicator.update",
        ai_state: "AI_STATE_GENERATING",
        cid: cid,
        message_id: message_id,
      });

      // Build the message history for context
      const fullPrompt = `${this.systemPrompt}\n\nUser message: ${this.userMessage}`;

      // Stream the response
      const result = await this.chatSession.sendMessageStream(fullPrompt);

      for await (const chunk of result.stream) {
        if (this.is_done) {
          break;
        }

        const chunkText = chunk.text();
        if (chunkText) {
          this.message_text += chunkText;
          const now = Date.now();

          // Update message every second or on final chunk
          if (now - this.last_update_time > 1000) {
            this.chatClient.partialUpdateMessage(message_id, {
              set: { text: this.message_text },
            });
            this.last_update_time = now;
          }
        }
      }

      // Final update with complete message
      if (!this.is_done) {
        this.chatClient.partialUpdateMessage(message_id, {
          set: { text: this.message_text },
        });

        await this.channel.sendEvent({
          type: "ai_indicator.clear",
          cid: cid,
          message_id: message_id,
        });
      }
    } catch (error) {
      console.error("An error occurred during Gemini response generation:", error);
      await this.handleError(error as Error);
    } finally {
      await this.dispose();
    }
  };

  dispose = async () => {
    if (this.is_done) {
      return;
    }
    this.is_done = true;
    this.chatClient.off("ai_indicator.stop", this.handleStopGenerating);
    this.onDispose();
  };

  private handleStopGenerating = async (event: any) => {
    if (this.is_done || event.message_id !== this.message.id) {
      return;
    }

    console.log("Stop generating for message", this.message.id);

    await this.channel.sendEvent({
      type: "ai_indicator.clear",
      cid: this.message.cid,
      message_id: this.message.id,
    });
    await this.dispose();
  };

  private handleError = async (error: Error) => {
    if (this.is_done) {
      return;
    }
    await this.channel.sendEvent({
      type: "ai_indicator.update",
      ai_state: "AI_STATE_ERROR",
      cid: this.message.cid,
      message_id: this.message.id,
    });
    await this.chatClient.partialUpdateMessage(this.message.id, {
      set: {
        text: error.message ?? "Error generating the message",
        message: error.toString(),
      },
    });
    await this.dispose();
  };
}
