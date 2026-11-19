package io.github.alexknight0.podcastplayer;

import androidx.core.content.ContextCompat;
import androidx.credentials.ClearCredentialStateRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

/**
 * Native Google sign-in (Credential Manager). Google blocks its OAuth pages inside a WebView,
 * so the site's signInWithPopup can't work in the app. JS calls
 * Capacitor.Plugins.GoogleSignIn.signIn({clientId}) and gets back a Google ID token, which
 * sync.js hands to Firebase with signInWithCredential.
 * clientId is the Firebase project's *web* OAuth client ID; Google checks this app's package
 * name + signing-key SHA-1 against the Android OAuth client in the same project.
 */
@CapacitorPlugin(name = "GoogleSignIn")
public class GoogleSignInPlugin extends Plugin {

    @PluginMethod
    public void signIn(PluginCall call) {
        String clientId = call.getString("clientId");
        if (clientId == null) {
            call.reject("clientId is required");
            return;
        }
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(new GetSignInWithGoogleOption.Builder(clientId).build())
            .build();
        CredentialManager.create(getContext()).getCredentialAsync(
            getActivity(),
            request,
            null,
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    Credential credential = response.getCredential();
                    if (credential instanceof CustomCredential
                        && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                        GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(credential.getData());
                        JSObject result = new JSObject();
                        result.put("idToken", google.getIdToken());
                        result.put("email", google.getId());
                        call.resolve(result);
                    } else {
                        call.reject("Unexpected credential type: " + credential.getType());
                    }
                }

                @Override
                public void onError(GetCredentialException e) {
                    String code = e instanceof GetCredentialCancellationException ? "cancelled" : e.getType();
                    call.reject(e.getMessage() != null ? e.getMessage() : code, code, e);
                }
            }
        );
    }

    /** Forget the chosen account, so the next sign-in shows the account picker again. */
    @PluginMethod
    public void signOut(PluginCall call) {
        CredentialManager.create(getContext()).clearCredentialStateAsync(
            new ClearCredentialStateRequest(),
            null,
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<Void, ClearCredentialException>() {
                @Override
                public void onResult(Void unused) {
                    call.resolve();
                }

                @Override
                public void onError(ClearCredentialException e) {
                    call.resolve(); // nothing useful to do; the Firebase sign-out already happened
                }
            }
        );
    }
}
