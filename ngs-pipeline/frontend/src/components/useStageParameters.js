import { useMemo, useState } from 'react'
import { resolveStageParameters } from '../../../shared/stageParameters.js'

export function useStageParameters(stage) {
  const [values, setValues] = useState({})
  const { plan, error } = useMemo(() => {
    try {
      return { plan: resolveStageParameters(stage, values) }
    } catch (validationError) {
      return { error: validationError.message }
    }
  }, [stage, values])

  return {
    parameters: plan?.parameters,
    args: plan?.args,
    fieldProps: { stage, values, setValues, error },
  }
}
