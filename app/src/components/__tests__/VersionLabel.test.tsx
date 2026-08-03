import React from 'react';
import { render } from '@testing-library/react-native';
import VersionLabel from '../VersionLabel';
import appJson from '../../../app.json';

describe('VersionLabel', () => {
  it('renders the app version from app.json prefixed with "v"', async () => {
    const { getByText } = await render(<VersionLabel />);
    expect(getByText(`v${appJson.expo.version}`)).toBeTruthy();
  });
});
