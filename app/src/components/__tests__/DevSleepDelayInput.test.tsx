import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import DevSleepDelayInput from '../DevSleepDelayInput';

describe('DevSleepDelayInput', () => {
  it('renders the current value', async () => {
    const { getByTestId } = await render(<DevSleepDelayInput value="5" onChangeText={jest.fn()} />);
    expect(getByTestId('dev-sleep-delay-input').props.value).toBe('5');
  });

  it('calls onChangeText when the input changes', async () => {
    const onChangeText = jest.fn();
    const { getByTestId } = await render(<DevSleepDelayInput value="5" onChangeText={onChangeText} />);

    fireEvent.changeText(getByTestId('dev-sleep-delay-input'), '12');

    expect(onChangeText).toHaveBeenCalledWith('12');
  });
});
