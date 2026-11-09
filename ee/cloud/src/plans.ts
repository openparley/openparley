export type PlanId = 'free' | 'team';
/** Plans sold through Polar; each has a Polar product. */
export type PaidPlanId = Exclude<PlanId, 'free'>;

export interface Plan {
  id: PlanId;
  name: string;
  /** Display only; the charged price is whatever the Polar product says. */
  price: string;
  summary: string;
  maxMembers: number | null;
  maxProjects: number | null;
  maxThreads: number | null;
}

/** Team's free trial. Polar applies it (set on the product); shown here for the pages. */
export const TRIAL_DAYS = 31;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    price: '$0',
    summary: 'For one person and their agents. Unlimited threads and projects.',
    maxMembers: 1,
    maxProjects: null,
    maxThreads: null,
  },
  team: {
    id: 'team',
    name: 'Team',
    price: '$19/month',
    summary: `For your whole team: unlimited members, threads and projects. First ${TRIAL_DAYS} days free.`,
    maxMembers: null,
    maxProjects: null,
    maxThreads: null,
  },
};

export const PAID_PLANS: PaidPlanId[] = ['team'];

export const isPlanId = (value: unknown): value is PlanId => typeof value === 'string' && Object.hasOwn(PLANS, value);
export const isPaidPlanId = (value: unknown): value is PaidPlanId => isPlanId(value) && value !== 'free';

/** The workspace limits a plan grants; always all of them, so a plan change also lifts limits. */
export const planLimits = (plan: Plan) => ({ maxMembers: plan.maxMembers, maxProjects: plan.maxProjects, maxThreads: plan.maxThreads });
