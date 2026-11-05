import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentLabApi, type AgentLabProvider } from "./agent-lab-api";
import { call } from "./http";

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  provider: AgentLabProvider;
  modelLabel?: string;
  replyState?: "failed" | "stopped";
}

/** Shell-owned conversation: survives navigation, collapsing and changing panel modes. */
export function useAgentChat(visible: boolean) {
  const [provider, setProvider] = useState<AgentLabProvider>("codex");
  const [models, setModels] = useState<Record<AgentLabProvider, string>>({ codex: "", claude: "" });
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [stopped, setStopped] = useState(false);
  const [unread, setUnread] = useState(false);
  const request = useRef<AbortController | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const status = useQuery({
    queryKey: ["agent-lab-status"], queryFn: agentLabApi.status,
    enabled: visible, retry: false, refetchOnWindowFocus: false, staleTime: 30_000,
    refetchInterval: query => visible && !pending && query.state.data?.busy ? 1000 : false,
  });
  useEffect(() => { if (visible) setUnread(false); }, [visible]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  const selected = status.data?.providers.find(entry => entry.id === provider);
  const forceCatalogRefresh = useRef(false);
  const catalog = useQuery({
    queryKey: ["agent-lab-models", provider],
    queryFn: ({ signal }) => {
      const refresh = forceCatalogRefresh.current;
      forceCatalogRefresh.current = false;
      return agentLabApi.models(provider, signal, refresh);
    },
    enabled: visible && selected?.available === true,
    retry: false, refetchOnWindowFocus: false, staleTime: 60_000,
  });
  const model = models[provider];
  const selectedModel = catalog.data?.models.find(entry => entry.id === model);
  const modelUnavailable = !!model && !catalog.isPending && !catalog.error && !catalog.data?.problem && !selectedModel;
  const setModel = (value: string) => setModels(current => ({ ...current, [provider]: value }));
  const refreshModels = () => { forceCatalogRefresh.current = true; void catalog.refetch(); };

  async function answer(turns: AgentMessage[]) {
    if (request.current || !selected?.available || modelUnavailable) return;
    const controller = new AbortController();
    request.current = controller;
    setMessages(turns);
    setPending(true);
    setProblem(undefined);
    setStopped(false);
    setUnread(false);
    // Keep recent context bounded independently of the visible transcript.
    const history: { role: AgentMessage["role"]; content: string }[] = [];
    let characters = 0;
    const completedContext = turns.filter((turn, index) => turn.role === "assistant" || turns[index + 1]?.role === "assistant" || index === turns.length - 1);
    for (const turn of [...completedContext].reverse()) {
      if (history.length === 12 || characters + turn.content.length > 30_000) break;
      history.unshift({ role: turn.role, content: turn.content });
      characters += turn.content.length;
    }
    try {
      const result = await call<{ answer: string }>("/agent-lab/chat", { provider, ...(model ? { model } : {}), messages: history }, controller.signal);
      if (request.current !== controller) return;
      setMessages([...turns, { id: crypto.randomUUID(), role: "assistant", content: result.answer, provider, modelLabel: selectedModel?.label }]);
      setUnread(!visibleRef.current);
    } catch (error) {
      if (request.current !== controller) return;
      setProblem(error instanceof Error ? error.message : String(error));
      setMessages(turns.map((turn, index) => index === turns.length - 1 ? { ...turn, replyState: "failed" } : turn));
      setUnread(!visibleRef.current);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
        void status.refetch();
      }
    }
  }
  const send = () => {
    if (!draft.trim() || draft.length > 4000 || request.current || !selected?.available || status.data?.busy || modelUnavailable) return;
    const turn: AgentMessage = { id: crypto.randomUUID(), role: "user", content: draft.trim(), provider };
    setDraft("");
    void answer([...messages, turn]);
  };
  const stop = () => {
    request.current?.abort(); request.current = null;
    setPending(false); setStopped(true);
    setMessages(current => current.map((turn, index) => index === current.length - 1 ? { ...turn, replyState: "stopped" } : turn));
    void status.refetch();
  };
  const clear = () => {
    if (request.current) return;
    setMessages([]); setProblem(undefined); setStopped(false); setUnread(false);
  };
  return {
    provider, setProvider, model, setModel, catalog, refreshModels, selectedModel, modelUnavailable,
    messages, draft, setDraft, pending, problem, stopped, unread,
    status, selected, send, stop, clear,
    retry: () => { if (messages.at(-1)?.role === "user") void answer(messages.map((turn, index) => index === messages.length - 1 ? { ...turn, replyState: undefined } : turn)); },
  };
}

export type AgentChat = ReturnType<typeof useAgentChat>;
