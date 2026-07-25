import { protectedApiPost } from "../../../api/protectedApiClient";

export const feedbackService = {

    async submitSuggestion(data) {
      try {
        return await protectedApiPost('/api/suggestion/submit', data);
  
      } catch (error) {
        console.error('Error submitting suggestion:', error);
        throw error;
      }
    }
  
  };
  
