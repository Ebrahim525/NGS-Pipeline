import { useId } from 'react'
import { STAGE_PARAMETERS } from '../../../shared/stageParameters.js'

export function StageParameters({ stage, values, setValues, error, disabled }) {
  const id = useId()

  return (
    <fieldset className="stage-parameters" disabled={disabled}>
      <legend>Parameters</legend>
      <div className="stage-parameters-grid">
        {Object.entries(STAGE_PARAMETERS[stage]).map(([key, field]) => {
          const inputId = `${id}-${key}`
          const value = values[key] ?? field.default ?? ''
          const onChange = (event) => {
            const value = field.type === 'boolean' ? event.target.checked : event.target.value
            setValues((previous) => ({ ...previous, [key]: value }))
          }
          return (
            <div className="qc-field" key={key}>
              {field.type === 'boolean' ? (
                <label htmlFor={inputId}>
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={value}
                    aria-describedby={field.help ? `${inputId}-help` : undefined}
                    onChange={onChange}
                  />
                  {' '}{field.label}
                </label>
              ) : (
                <>
                  <label htmlFor={inputId}>{field.label}</label>
                  <input
                    id={inputId}
                    className="qc-input"
                    type={field.type === 'token' ? 'text' : 'number'}
                    value={value}
                    min={field.min}
                    max={field.max}
                    step={field.type === 'number' ? 'any' : undefined}
                    maxLength={field.maxLength ?? (field.type === 'token' ? 128 : undefined)}
                    aria-describedby={field.help ? `${inputId}-help` : undefined}
                    onChange={onChange}
                  />
                </>
              )}
              {field.help && <p className="qc-hint" id={`${inputId}-help`}>{field.help}</p>}
            </div>
          )
        })}
      </div>
      {error && <div className="qc-error" role="alert">{error}</div>}
    </fieldset>
  )
}
