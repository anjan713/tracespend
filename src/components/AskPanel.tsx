import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, CornerDownLeft, Loader2, RotateCcw } from 'lucide-react';
import type { AskResponse } from '../lib/ask';
import { STARTER_PROMPTS } from '../lib/intent';

interface Message {
  role: 'user' | 'agent';
  text: string;
  facts?: { label: string; value: string }[];
  prose?: string | null;
  loading?: boolean;
  error?: boolean;
  retryQ?: string;
}

interface Props {
  onAsk: (q: string) => Promise<AskResponse>;
}

function replaceLastAgent(messages: Message[], patch: Partial<Message>): Message[] {
  const copy = [...messages];
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === 'agent') {
      copy[i] = { ...copy[i], ...patch };
      break;
    }
  }
  return copy;
}

export default function AskPanel({ onAsk }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const submit = async (q: string) => {
    const query = q.trim();
    if (!query) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: query }, { role: 'agent', text: '', loading: true }]);
    try {
      const r = await onAsk(query);
      setMessages((m) => replaceLastAgent(m, { text: r.answer, prose: r.prose, facts: r.facts, loading: false }));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The AI is unavailable — please retry.';
      setMessages((m) => replaceLastAgent(m, { text: message, loading: false, error: true, retryQ: query }));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-white/5 px-4 py-3">
        <p className="panel-sub">AI Agent</p>
        <h2 className="mt-0.5 flex items-center gap-1.5 text-lg font-semibold text-cream">
          <Sparkles size={16} className="text-gold-300" /> Ask Tracespend
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-mute">
          Ask in plain English. The agent moves the sundial and answers with exact, source-verified numbers.
        </p>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-mute">Try asking</p>
            {STARTER_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => submit(p)}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-white/8 bg-ink-800/60 px-3 py-2 text-left text-sm text-cream transition hover:border-gold-300/40 hover:bg-ink-700/60 hover:text-gold-100"
              >
                <span>{p}</span>
                <CornerDownLeft size={13} className="shrink-0 text-mute" />
              </button>
            ))}
          </div>
        ) : (
          messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-gold-300 px-3 py-2 text-sm font-medium text-ink-900">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} className="animate-fade-up space-y-2">
                <div
                  className={`rounded-2xl rounded-bl-sm border px-3 py-2.5 ${
                    m.error ? 'border-rose-400/30 bg-rose-500/10' : 'border-white/8 bg-ink-800/70'
                  }`}
                >
                  {m.loading ? (
                    <p className="flex items-center gap-2 text-sm text-mute">
                      <Loader2 size={14} className="animate-spin text-gold-300" />
                      <span className="animate-pulse">Thinking…</span>
                    </p>
                  ) : m.error ? (
                    <div className="space-y-2">
                      <p className="text-sm leading-relaxed text-rose-200">{m.text}</p>
                      {m.retryQ && (
                        <button onClick={() => submit(m.retryQ!)} className="btn-ghost text-xs">
                          <RotateCcw size={13} /> Retry
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      <p className="text-sm leading-relaxed text-cream">{m.prose || m.text}</p>
                      {m.prose && (
                        <p className="mt-1.5 border-t border-white/5 pt-1.5 text-[11px] leading-relaxed text-mute">
                          {m.text}
                        </p>
                      )}
                      {m.facts && m.facts.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {m.facts.map((f, fi) => (
                            <span key={fi} className="chip">
                              <span className="text-mute">{f.label}</span>
                              <span className="font-mono font-semibold text-gold-100">{f.value}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {!m.loading && !m.error && (
                  <p className="pl-1 text-[10px] text-mute/60">numbers verified by the query worker</p>
                )}
              </div>
            )
          )
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="border-t border-white/5 p-3"
      >
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about the spending…"
            className="field"
          />
          <button type="submit" className="btn-gold shrink-0" aria-label="Send">
            <Send size={15} />
          </button>
        </div>
      </form>
    </div>
  );
}
