export interface WorkflowWeight {
  inputMultiplier: number;
  outputMultiplier: number;
  orchestrationMultiplier: number;
  retryPenalty: number;
}

const DEFAULT_WORKFLOW_WEIGHT: WorkflowWeight = {
  inputMultiplier: 1,
  outputMultiplier: 1,
  orchestrationMultiplier: 1,
  retryPenalty: 0.3,
};

const WORKFLOW_REGISTRY: Array<{ match: RegExp; weight: WorkflowWeight }> = [
  {
    match: /panel\/editagent/i,
    weight: {
      inputMultiplier: 2.4,
      outputMultiplier: 2.6,
      orchestrationMultiplier: 2.2,
      retryPenalty: 0.55,
    },
  },
  {
    match: /executionsubagenttool|subagent/i,
    weight: {
      inputMultiplier: 2.1,
      outputMultiplier: 1.8,
      orchestrationMultiplier: 2.5,
      retryPenalty: 0.45,
    },
  },
  {
    match: /summarizeconversationhistory|summary/i,
    weight: {
      inputMultiplier: 1.4,
      outputMultiplier: 0.6,
      orchestrationMultiplier: 1.2,
      retryPenalty: 0.25,
    },
  },
  {
    match: /progressmessages/i,
    weight: {
      inputMultiplier: 0.6,
      outputMultiplier: 0.35,
      orchestrationMultiplier: 0.65,
      retryPenalty: 0.2,
    },
  },
  {
    match: /chat\/edit|agent\/apply/i,
    weight: {
      inputMultiplier: 1.5,
      outputMultiplier: 1.35,
      orchestrationMultiplier: 1.3,
      retryPenalty: 0.35,
    },
  },
];

export function resolveWorkflowWeight(feature: string): WorkflowWeight {
  for (const entry of WORKFLOW_REGISTRY) {
    if (entry.match.test(feature)) {
      return entry.weight;
    }
  }
  return DEFAULT_WORKFLOW_WEIGHT;
}