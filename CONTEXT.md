# Tracespend

An animated sundial explorer for government vendor payments, with an Ask-the-data
Q&A pipeline. The chart works standalone; answering is the part that involves a
language model.

## Language

**Model endpoint**:
A configured target that answers chat-completion requests — a base URL, a key,
and a model name, together. The provider is a property of the endpoint, not a
branch in the code.
_Avoid_: Provider (ambiguous — OpenAI-the-company vs. a gateway), model (that is
one field of an endpoint), LLM.

**OpenAI-compatible**:
Speaking the OpenAI chat-completions wire format — `POST {base}/chat/completions`
with `Authorization: Bearer`, a `messages` array, and a `choices[0].message.content`
response. It describes the shape of the request, never which company serves it.
_Avoid_: Using it to mean "runs on OpenAI models".
